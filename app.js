/**
 * 실시간 양방향 통역 PWA
 *
 * 전략:
 * - 마이크는 1개만 사용 (getUserMedia 한 번)
 * - WebRTC 세션 2개를 미리 열어둠 (한→영, 영→한 방향)
 * - 두 세션 모두에 같은 마이크 트랙을 추가하되, 평소엔 양쪽 다 enabled=false
 * - PTT 버튼을 누르고 있는 동안만 해당 방향 세션의 트랙을 enable
 * - 마이크 1개 + 트랙 게이팅으로 피드백 루프와 화자 혼동 방지
 */

const LANG_TO_FLAG = {
  ko: '🇰🇷', en: '🇺🇸', ja: '🇯🇵', zh: '🇨🇳', es: '🇪🇸',
  fr: '🇫🇷', de: '🇩🇪', it: '🇮🇹', pt: '🇵🇹', ru: '🇷🇺',
  hi: '🇮🇳', id: '🇮🇩', vi: '🇻🇳',
};

const LANG_TO_SHORT = {
  ko: '한', en: 'EN', ja: '日', zh: '中', es: 'ES',
  fr: 'FR', de: 'DE', it: 'IT', pt: 'PT', ru: 'RU',
  hi: 'हि', id: 'ID', vi: 'VI',
};

const SDP_URL = 'https://api.openai.com/v1/realtime/translations/calls';
const MODEL = 'gpt-realtime-translate';

const els = {
  status: document.getElementById('status'),
  pttMe: document.getElementById('pttMe'),
  pttPartner: document.getElementById('pttPartner'),
  pttMeLabel: document.getElementById('pttMeLabel'),
  pttPartnerLabel: document.getElementById('pttPartnerLabel'),
  myLang: document.getElementById('myLang'),
  partnerLang: document.getElementById('partnerLang'),
  myFlag: document.getElementById('myFlag'),
  partnerFlag: document.getElementById('partnerFlag'),
  meSrc: document.getElementById('meSrc'),
  meDst: document.getElementById('meDst'),
  partnerSrc: document.getElementById('partnerSrc'),
  partnerDst: document.getElementById('partnerDst'),
  audioMeToPartner: document.getElementById('audioMeToPartner'),
  audioPartnerToMe: document.getElementById('audioPartnerToMe'),
};

// 세션 객체 두 개를 보관
const sessions = {
  // 내가 말함 → 상대 언어로 통역 (상대가 듣는 음성)
  meToPartner: null,
  // 상대가 말함 → 내 언어로 통역 (내가 듣는 음성)
  partnerToMe: null,
};

let micStream = null;
let activeDirection = null; // 'meToPartner' | 'partnerToMe' | null

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.classList.remove('is-ok', 'is-error', 'is-listening');
  if (kind === 'ok') els.status.classList.add('is-ok');
  if (kind === 'error') els.status.classList.add('is-error');
  if (kind === 'listening') els.status.classList.add('is-listening');
}

function haptic(ms = 12) {
  if ('vibrate' in navigator) {
    try { navigator.vibrate(ms); } catch {}
  }
}

function updateLangBadges() {
  const my = els.myLang.value;
  const partner = els.partnerLang.value;
  els.myFlag.textContent = LANG_TO_FLAG[my] || '🏳️';
  els.partnerFlag.textContent = LANG_TO_FLAG[partner] || '🏳️';
  els.pttMeLabel.textContent = LANG_TO_SHORT[my] || my.toUpperCase();
  els.pttPartnerLabel.textContent = LANG_TO_SHORT[partner] || partner.toUpperCase();
}

async function fetchClientSecret(targetLanguage) {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetLanguage }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `토큰 발급 실패 (${res.status})`);
  }
  const data = await res.json();
  // OpenAI 응답 포맷: { value: "ek_...", expires_at: ... } 또는 { client_secret: { value, expires_at } }
  const secret = data.value || data.client_secret?.value || data.client_secret;
  if (!secret) throw new Error('client_secret이 응답에 없습니다.');
  return secret;
}

/**
 * 단일 통역 세션(한 방향) 생성
 * @param {object} opts
 * @param {string} opts.targetLanguage - 출력 언어 (듣는 사람의 언어)
 * @param {MediaStreamTrack} opts.micTrack - 마이크 트랙 (공유)
 * @param {HTMLAudioElement} opts.audioOut - 번역 음성을 재생할 audio 엘리먼트
 * @param {(srcDelta: string) => void} opts.onSrc - 원문 자막 콜백
 * @param {(dstDelta: string) => void} opts.onDst - 번역문 자막 콜백
 */
async function openSession({ targetLanguage, micTrack, audioOut, onSrc, onDst }) {
  const clientSecret = await fetchClientSecret(targetLanguage);

  const pc = new RTCPeerConnection();
  const events = pc.createDataChannel('oai-events');

  // 번역된 오디오 수신
  pc.ontrack = ({ streams }) => {
    if (streams && streams[0]) {
      audioOut.srcObject = streams[0];
    }
  };

  // 마이크 트랙 추가. 시작은 비활성 상태.
  micTrack.enabled = false;
  const sender = pc.addTrack(micTrack);

  events.addEventListener('message', (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }
    if (evt.type === 'session.input_transcript.delta' && evt.delta) onSrc(evt.delta);
    if (evt.type === 'session.output_transcript.delta' && evt.delta) onDst(evt.delta);
    if (evt.type === 'session.input_transcript.completed') onSrc('\n');
    if (evt.type === 'session.output_transcript.completed') onDst('\n');
    if (evt.type === 'error') console.warn('[OpenAI error]', evt);
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const sdpRes = await fetch(`${SDP_URL}?model=${MODEL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      'Content-Type': 'application/sdp',
    },
    body: offer.sdp,
  });

  if (!sdpRes.ok) {
    throw new Error(`SDP 교환 실패 (${sdpRes.status}): ${await sdpRes.text()}`);
  }

  await pc.setRemoteDescription({
    type: 'answer',
    sdp: await sdpRes.text(),
  });

  await waitForConnected(pc);

  return { pc, sender, micTrack, dataChannel: events };
}

function waitForConnected(pc, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (pc.connectionState === 'connected') return resolve();
    const timer = setTimeout(() => reject(new Error('연결 타임아웃')), timeoutMs);
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') {
        clearTimeout(timer);
        resolve();
      } else if (pc.connectionState === 'failed') {
        clearTimeout(timer);
        reject(new Error('연결 실패'));
      }
    });
  });
}

async function ensureMic() {
  if (micStream) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  return micStream;
}

async function initSessions() {
  setStatus('마이크 권한 요청…');
  await ensureMic();

  setStatus('연결 중…');

  const myLang = els.myLang.value;
  const partnerLang = els.partnerLang.value;

  // 같은 마이크 트랙을 양쪽 세션에 공유
  const micTrack = micStream.getAudioTracks()[0];

  // 세션 두 개를 병렬로 오픈
  const [meToPartner, partnerToMe] = await Promise.all([
    openSession({
      targetLanguage: partnerLang, // 상대가 듣는 언어
      micTrack,
      audioOut: els.audioMeToPartner,
      onSrc: (d) => appendSubtitle(els.meSrc, d),
      onDst: (d) => appendSubtitle(els.partnerDst, d),
    }),
    openSession({
      targetLanguage: myLang, // 내가 듣는 언어
      micTrack,
      audioOut: els.audioPartnerToMe,
      onSrc: (d) => appendSubtitle(els.partnerSrc, d),
      onDst: (d) => appendSubtitle(els.meDst, d),
    }),
  ]);

  sessions.meToPartner = meToPartner;
  sessions.partnerToMe = partnerToMe;

  // 시작 시 양쪽 트랙 모두 비활성
  micTrack.enabled = false;

  setStatus('준비됨', 'ok');
  els.pttMe.disabled = false;
  els.pttPartner.disabled = false;
}

const MAX_LINES = 6;
function appendSubtitle(el, delta) {
  el.textContent += delta;
  // 너무 길어지면 마지막 몇 줄만 유지
  const lines = el.textContent.split('\n');
  if (lines.length > MAX_LINES) {
    el.textContent = lines.slice(-MAX_LINES).join('\n');
  }
  el.scrollTop = el.scrollHeight;
}

function clearSubtitlesFor(direction) {
  if (direction === 'meToPartner') {
    els.meSrc.textContent = '';
    els.partnerDst.textContent = '';
  } else {
    els.partnerSrc.textContent = '';
    els.meDst.textContent = '';
  }
}

/**
 * Push-to-talk 활성화: 한 방향만 마이크 enable.
 * 동시에 양쪽 trakck.enabled를 토글하므로 한 마이크가 두 세션에 동시 입력되는 일은 없다.
 */
function startTalk(direction) {
  if (!sessions.meToPartner || !sessions.partnerToMe) return;
  if (activeDirection) return; // 이미 누군가 말하는 중

  activeDirection = direction;
  // 안전: 양쪽 둘 다 한 번 끄고
  sessions.meToPartner.micTrack.enabled = false;
  // (같은 트랙이므로 사실 한 번만 끄면 됨, 가독성을 위해 명시)

  // 누르는 쪽만 켠다.
  // 마이크 트랙은 양쪽 세션이 공유하므로 한 번만 enable 하면 충분.
  // 하지만 "어느 세션이 듣는가"는 RTP 송신이 이뤄지는지 여부 = sender의 트랙 활성화 여부.
  // RTCPeerConnection은 같은 트랙을 공유해도 sender별로 별도 RTP 스트림을 보낸다.
  // → 트랙 자체를 enable/disable하면 양쪽 모두 영향. 우리는 그게 의도가 아님.
  // → 그래서 sender.replaceTrack(null/track) 으로 방향별 게이팅한다.

  const active = sessions[direction];
  const inactive = direction === 'meToPartner' ? sessions.partnerToMe : sessions.meToPartner;

  // 활성 방향: 마이크 트랙 연결
  active.sender.replaceTrack(active.micTrack);
  // 비활성 방향: 트랙 끊기 (null로)
  inactive.sender.replaceTrack(null);

  active.micTrack.enabled = true;

  clearSubtitlesFor(direction);

  const btn = direction === 'meToPartner' ? els.pttMe : els.pttPartner;
  btn.classList.add('is-active');
  setStatus(direction === 'meToPartner' ? '듣는 중 · 나' : '듣는 중 · 상대', 'listening');
  haptic(15);
}

function stopTalk() {
  if (!activeDirection) return;

  const active = sessions[activeDirection];
  if (active) {
    active.sender.replaceTrack(null);
  }

  if (micStream) {
    micStream.getAudioTracks().forEach((t) => (t.enabled = false));
  }

  els.pttMe.classList.remove('is-active');
  els.pttPartner.classList.remove('is-active');
  setStatus('준비됨', 'ok');
  haptic(8);
  activeDirection = null;
}

// PTT 이벤트 바인딩 (마우스 + 터치 + 키보드)
function bindPTT(btn, direction) {
  const start = (e) => {
    e.preventDefault();
    startTalk(direction);
  };
  const end = (e) => {
    e.preventDefault();
    stopTalk();
  };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointerleave', end);
  btn.addEventListener('pointercancel', end);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

async function reinitOnLangChange() {
  // 언어가 바뀌면 세션을 다시 만들어야 한다 (출력 언어는 세션 생성 시 고정)
  setStatus('언어 변경 → 재연결…');
  els.pttMe.disabled = true;
  els.pttPartner.disabled = true;
  try {
    if (sessions.meToPartner) sessions.meToPartner.pc.close();
    if (sessions.partnerToMe) sessions.partnerToMe.pc.close();
  } catch {}
  sessions.meToPartner = null;
  sessions.partnerToMe = null;
  try {
    await initSessions();
  } catch (err) {
    console.error(err);
    setStatus(`오류: ${err.message}`, 'error');
  }
}

function init() {
  updateLangBadges();
  els.myLang.addEventListener('change', () => {
    updateLangBadges();
    reinitOnLangChange();
  });
  els.partnerLang.addEventListener('change', () => {
    updateLangBadges();
    reinitOnLangChange();
  });

  els.pttMe.disabled = true;
  els.pttPartner.disabled = true;
  bindPTT(els.pttMe, 'meToPartner');
  bindPTT(els.pttPartner, 'partnerToMe');

  // 최초 사용자 제스처(첫 탭/클릭) 후 세션 시작 → iOS Safari 마이크/오디오 정책 회피
  const bootstrap = async () => {
    document.removeEventListener('click', bootstrap);
    document.removeEventListener('touchstart', bootstrap);
    try {
      await initSessions();
    } catch (err) {
      console.error(err);
      setStatus(`오류: ${err.message}`, 'error');
    }
  };
  document.addEventListener('click', bootstrap, { once: false });
  document.addEventListener('touchstart', bootstrap, { once: false });

  setStatus('화면을 한 번 탭하세요');

  // 서비스워커 등록
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  }
}

init();
