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

// 큰 표시용 언어 코드
const LANG_TO_CODE = {
  ko: 'KO', en: 'EN', ja: 'JA', zh: 'ZH', es: 'ES',
  fr: 'FR', de: 'DE', it: 'IT', pt: 'PT', ru: 'RU',
  hi: 'HI', id: 'ID', vi: 'VI',
};

// 한국어 이름
const LANG_TO_NAME = {
  ko: '한국어', en: '영어', ja: '일본어', zh: '중국어', es: '스페인어',
  fr: '프랑스어', de: '독일어', it: '이탈리아어', pt: '포르투갈어', ru: '러시아어',
  hi: '힌디어', id: '인도네시아어', vi: '베트남어',
};

// 버튼 라벨 (한국어 짧은 이름)
const LANG_TO_SHORT = {
  ko: '한국어', en: '영어', ja: '일본어', zh: '중국어', es: '스페인어',
  fr: '프랑스어', de: '독일어', it: '이탈리아어', pt: '포르투갈어', ru: '러시아어',
  hi: '힌디어', id: '인니어', vi: '베트남어',
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
  myCode: document.getElementById('myCode'),
  myName: document.getElementById('myName'),
  partnerCode: document.getElementById('partnerCode'),
  partnerName: document.getElementById('partnerName'),
  panelMe: document.getElementById('panelMe'),
  panelPartner: document.getElementById('panelPartner'),
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

/* ============================================
   오디오 파이프라인 (마이크 → 게이트 → 송신 트랙)
   ============================================
   원본 마이크 트랙은 항상 활성 유지 (VAD가 RMS를 계속 측정할 수 있게).
   대신 GainNode로 송신 볼륨을 게이팅한다:
     - VAD가 침묵 감지 → gain 0 (OpenAI에는 침묵 전송)
     - VAD가 음성 감지 → gain 1 (정상 전송)
   PeerConnection에는 합성된 outboundTrack을 추가한다.
*/
let audioPipeline = {
  ctx: null,           // 분석/게이팅용 AudioContext (출력과 분리)
  source: null,        // 마이크 MediaStreamSource
  analyser: null,      // RMS 측정용
  gate: null,          // 송신 게이트 (GainNode)
  destination: null,   // MediaStreamDestination
  outboundTrack: null, // 두 세션이 공유할 송신 트랙
  buf: null,
};

function buildAudioPipeline() {
  if (audioPipeline.outboundTrack) return audioPipeline; // 이미 구축됨
  if (!micStream) throw new Error('마이크 스트림이 없습니다.');

  const ctx = getVadContext();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  const source = ctx.createMediaStreamSource(micStream);

  // 1) 분석 분기 — destination 미연결, 출력 영향 없음
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.4;
  source.connect(analyser);

  // 2) 송신 분기 — GainNode로 게이팅 후 MediaStreamDestination으로
  const gate = ctx.createGain();
  gate.gain.value = 1; // 평소 1, VAD가 0으로 게이팅
  const destination = ctx.createMediaStreamDestination();
  source.connect(gate).connect(destination);

  const outboundTrack = destination.stream.getAudioTracks()[0];

  audioPipeline = {
    ctx, source, analyser, gate, destination, outboundTrack,
    buf: new Float32Array(analyser.fftSize),
  };
  return audioPipeline;
}

function destroyAudioPipeline() {
  try { audioPipeline.source?.disconnect(); } catch {}
  try { audioPipeline.analyser?.disconnect(); } catch {}
  try { audioPipeline.gate?.disconnect(); } catch {}
  try { audioPipeline.destination?.disconnect(); } catch {}
  audioPipeline = {
    ctx: null, source: null, analyser: null, gate: null,
    destination: null, outboundTrack: null, buf: null,
  };
}

/* ============================================
   VAD — GainNode 게이팅 사용
   ============================================
   마이크 트랙은 항상 활성, 대신 송신 볼륨만 0/1로 토글한다.
   따라서 사용자가 다시 말하기 시작하면 RMS가 즉시 올라가서 감지됨.
*/
const VAD_SILENCE_MS = 1200;
const VAD_CHECK_INTERVAL = 80;
const VAD_THRESHOLD = 0.018;
const VAD_RAMP_MS = 30;     // gain 변경 시 살짝 ramp (클릭/팝 노이즈 방지)

let vad = {
  timer: null,
  lastVoiceAt: 0,
  gatedOff: false,
};

function applyGain(value) {
  if (!audioPipeline.gate || !audioPipeline.ctx) return;
  const now = audioPipeline.ctx.currentTime;
  audioPipeline.gate.gain.cancelScheduledValues(now);
  audioPipeline.gate.gain.setValueAtTime(audioPipeline.gate.gain.value, now);
  audioPipeline.gate.gain.linearRampToValueAtTime(value, now + VAD_RAMP_MS / 1000);
}

function startVAD() {
  if (vad.timer) return;
  if (!audioPipeline.analyser) return;

  vad.lastVoiceAt = Date.now();
  vad.gatedOff = false;
  applyGain(1);

  vad.timer = setInterval(() => {
    if (!activeDirection) return;
    audioPipeline.analyser.getFloatTimeDomainData(audioPipeline.buf);

    let sum = 0;
    const buf = audioPipeline.buf;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);

    const now = Date.now();
    const isVoice = rms > VAD_THRESHOLD;

    if (isVoice) {
      vad.lastVoiceAt = now;
      if (vad.gatedOff) {
        applyGain(1);
        vad.gatedOff = false;
        setStatus('듣는 중', 'listening');
      }
    } else {
      const silentFor = now - vad.lastVoiceAt;
      if (silentFor >= VAD_SILENCE_MS && !vad.gatedOff) {
        applyGain(0);
        vad.gatedOff = true;
        setStatus('대기 중', 'ok');
      }
    }
  }, VAD_CHECK_INTERVAL);
}

function stopVAD() {
  if (vad.timer) {
    clearInterval(vad.timer);
    vad.timer = null;
  }
  vad.gatedOff = false;
  applyGain(1); // 안전: 게이트 복귀해서 다음 세션에 영향 없게
}

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

/**
 * 모바일에서 WebRTC 오디오를 라우드스피커(미디어 출력)로 강제 라우팅.
 *
 * 핵심: 출력용 AudioContext와 마이크 분석용 AudioContext를 분리한다.
 * 마이크 input source를 출력 컨텍스트에 붙이면 브라우저가 "음성통화"로
 * 판단해 출력을 이어피스로 라우팅하는 버그가 있다.
 *
 * - outputCtx: 통역 음성 재생용 (destination 연결, 라우드스피커)
 * - vadCtx:    마이크 RMS 분석 전용 (destination 미연결, 출력에 영향 없음)
 */
let outputCtx = null;
let vadCtx = null;

function getOutputContext() {
  if (!outputCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    outputCtx = new Ctx({ latencyHint: 'interactive' });
  }
  return outputCtx;
}

function getVadContext() {
  if (!vadCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    // 분석 전용이라 sampleRate를 낮춰도 충분
    vadCtx = new Ctx({ latencyHint: 'playback' });
  }
  return vadCtx;
}

// 하위 호환: 기존에 getAudioContext() 호출하던 경로는 출력 컨텍스트로 라우팅
function getAudioContext() { return getOutputContext(); }

function routeToLoudspeaker(stream, sinkEl) {
  // (1) iOS 안전장치: srcObject 연결 + 음소거. 트랙이 죽지 않도록.
  try {
    sinkEl.srcObject = stream;
    sinkEl.muted = true;
    sinkEl.playsInline = true;
    sinkEl.setAttribute('playsinline', '');
    // play()는 사용자 제스처 후에만 성공. 실패해도 무시 (muted라 영향 없음).
    sinkEl.play?.().catch(() => {});
  } catch {}

  // (2) AudioContext 경로로 실제 재생 (라우드스피커, 미디어 볼륨)
  try {
    const ctx = getAudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = 1.6; // 살짝 부스트 — 모바일에서 통역 음성이 작은 경향
    src.connect(gain).connect(ctx.destination);
    // resume은 첫 사용자 제스처 후에만 가능 → bootstrap에서 한 번 해줌
  } catch (err) {
    console.warn('AudioContext routing 실패, srcObject 폴백:', err);
    // 폴백: 일반 재생
    try {
      sinkEl.muted = false;
      sinkEl.play?.().catch(() => {});
    } catch {}
  }
}

function updateLangBadges() {
  const my = els.myLang.value;
  const partner = els.partnerLang.value;
  els.myCode.textContent = LANG_TO_CODE[my] || my.toUpperCase();
  els.myName.textContent = LANG_TO_NAME[my] || my;
  els.partnerCode.textContent = LANG_TO_CODE[partner] || partner.toUpperCase();
  els.partnerName.textContent = LANG_TO_NAME[partner] || partner;
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
 * outboundTrack은 audioPipeline.outboundTrack (마이크→게이트 후 합성된 트랙)
 */
async function openSession({ targetLanguage, outboundTrack, audioOut, onSrc, onDst }) {
  const clientSecret = await fetchClientSecret(targetLanguage);

  const pc = new RTCPeerConnection();
  const events = pc.createDataChannel('oai-events');

  // 세션 상태 (트레일링 그레이스 판단용)
  const state = {
    lastDeltaAt: 0,            // 마지막으로 자막/오디오 델타가 도착한 시각 (ms)
    outputCompletedAt: 0,      // output_transcript.completed 받은 시각
    completed: false,          // 마지막 발화에 대한 결과를 모두 받았는지
  };
  const markActivity = () => {
    state.lastDeltaAt = Date.now();
    state.completed = false;
  };

  // 번역된 오디오 수신.
  // 모바일에서 WebRTC 오디오를 audio.srcObject로 바로 재생하면 브라우저가
  // "음성통화 모드"로 라우팅 → 이어피스로 작게 나옴.
  // 해결: AudioContext를 거쳐 미디어 스트림으로 재생 → 미디어 볼륨/라우드스피커로 출력.
  pc.ontrack = ({ streams }) => {
    if (!streams || !streams[0]) return;
    routeToLoudspeaker(streams[0], audioOut);
  };

  // 송신 트랙 추가. PTT 비활성 상태에서는 replaceTrack(null)로 송신 끊을 예정.
  // 트랙 자체는 enabled를 토글하지 않는다 (RMS 측정/게이팅이 항상 가능해야 하므로).
  const sender = pc.addTrack(outboundTrack);

  events.addEventListener('message', (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }
    if (evt.type === 'session.input_transcript.delta' && evt.delta) {
      onSrc(evt.delta);
      markActivity();
    }
    if (evt.type === 'session.output_transcript.delta' && evt.delta) {
      onDst(evt.delta);
      markActivity();
    }
    if (evt.type === 'session.output_audio.delta') {
      markActivity();
      // ducking은 사용하지 않음 — 동시통역을 위해.
      // 사용자가 말을 멈추면 VAD가 자동으로 마이크를 게이팅해서 피드백을 막는다.
    }
    if (evt.type === 'session.input_transcript.completed') onSrc('\n');
    if (evt.type === 'session.output_transcript.completed') {
      onDst('\n');
      state.outputCompletedAt = Date.now();
      state.completed = true;
    }
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

  return { pc, sender, outboundTrack, dataChannel: events, state };
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
  // 모바일이 통화모드(이어피스)로 라우팅하는 핵심 트리거가
  // echoCancellation/통화특화 옵션인 경우가 많다.
  // VAD가 침묵 시 마이크를 자동 OFF하므로 피드백 1차 차단은 우리가 직접 한다.
  // → AEC/voice 특화 옵션을 끄고 라우드스피커 유지.
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
      // 일부 브라우저에서 인식하는 추가 힌트들. 알 수 없는 키는 그냥 무시됨.
      googEchoCancellation: false,
      googAutoGainControl: true,
      googNoiseSuppression: true,
      googHighpassFilter: true,
    },
    video: false,
  });
  return micStream;
}

async function initSessions() {
  setStatus('권한 요청');
  await ensureMic();

  // 마이크 → AnalyserNode (RMS) + GainNode → 합성 송신 트랙
  // 한 번 만들어두고 양쪽 세션이 같은 outboundTrack을 공유한다.
  const pipeline = buildAudioPipeline();

  setStatus('연결 중');

  const myLang = els.myLang.value;
  const partnerLang = els.partnerLang.value;

  const [meToPartner, partnerToMe] = await Promise.all([
    openSession({
      targetLanguage: partnerLang,
      outboundTrack: pipeline.outboundTrack,
      audioOut: els.audioMeToPartner,
      onSrc: (d) => appendSubtitle(els.meSrc, d),
      onDst: (d) => appendSubtitle(els.partnerDst, d),
    }),
    openSession({
      targetLanguage: myLang,
      outboundTrack: pipeline.outboundTrack,
      audioOut: els.audioPartnerToMe,
      onSrc: (d) => appendSubtitle(els.partnerSrc, d),
      onDst: (d) => appendSubtitle(els.meDst, d),
    }),
  ]);

  sessions.meToPartner = meToPartner;
  sessions.partnerToMe = partnerToMe;

  // 시작 직후엔 양쪽 sender에서 트랙 분리 (어느 방향도 송신 안 함)
  try { meToPartner.sender.replaceTrack(null); } catch {}
  try { partnerToMe.sender.replaceTrack(null); } catch {}

  setStatus('준비', 'ok');
  els.pttMe.disabled = false;
  els.pttPartner.disabled = false;
}

/* ============================================
   자막 관리: 발화 단위 + 페이드 아웃
   ============================================ */

const MAX_CHARS = 240;        // 한 발화 내 글자 수 상한 (넘으면 앞쪽 잘림)
const FADE_DELAY_MS = 3500;   // 발화 완료 후 페이드 아웃까지 대기
const FADE_DURATION_MS = 600; // 페이드 아웃 자체 시간

// 각 자막 element별 상태: { fadeTimer, removeTimer, isFading }
const subtitleState = new WeakMap();

function getSubState(el) {
  let s = subtitleState.get(el);
  if (!s) {
    s = { fadeTimer: null, removeTimer: null, isFading: false };
    subtitleState.set(el, s);
  }
  return s;
}

function cancelFade(el) {
  const s = getSubState(el);
  if (s.fadeTimer) { clearTimeout(s.fadeTimer); s.fadeTimer = null; }
  if (s.removeTimer) { clearTimeout(s.removeTimer); s.removeTimer = null; }
  if (s.isFading) {
    el.style.transition = '';
    el.style.opacity = '';
    s.isFading = false;
  }
}

function appendSubtitle(el, delta) {
  // 새 델타가 들어옴 = 발화 진행 중. 페이드 예약을 취소.
  cancelFade(el);

  // 페이드 아웃이 끝나 비어있는 상태였다면 깨끗하게 시작
  if (el.dataset.spent === '1') {
    el.textContent = '';
    el.dataset.spent = '';
  }

  el.textContent += delta;

  // 너무 길어지면 앞쪽 잘라내기 (한 발화 내 누적 방지)
  if (el.textContent.length > MAX_CHARS) {
    el.textContent = '…' + el.textContent.slice(-MAX_CHARS);
  }
}

/**
 * 발화 완료 신호. 일정 시간 후 자막을 페이드 아웃해서 비움.
 */
function scheduleFadeOut(el) {
  if (!el.textContent) return;
  cancelFade(el);
  const s = getSubState(el);

  s.fadeTimer = setTimeout(() => {
    s.fadeTimer = null;
    s.isFading = true;
    el.style.transition = `opacity ${FADE_DURATION_MS}ms ease-out`;
    el.style.opacity = '0';

    s.removeTimer = setTimeout(() => {
      s.removeTimer = null;
      s.isFading = false;
      el.textContent = '';
      el.dataset.spent = '1';
      el.style.transition = '';
      el.style.opacity = '';
    }, FADE_DURATION_MS);
  }, FADE_DELAY_MS);
}

function clearSubtitlesFor(direction) {
  const targets = direction === 'meToPartner'
    ? [els.meSrc, els.partnerDst]
    : [els.partnerSrc, els.meDst];
  for (const el of targets) {
    cancelFade(el);
    el.textContent = '';
    el.dataset.spent = '';
  }
}

/**
 * 한 방향의 자막 두 줄(원문/번역)에 동시에 페이드 아웃 예약
 */
function scheduleFadeOutForDirection(direction) {
  const targets = direction === 'meToPartner'
    ? [els.meSrc, els.partnerDst]
    : [els.partnerSrc, els.meDst];
  for (const el of targets) scheduleFadeOut(el);
}

/**
 * Push-to-talk 활성화: 한 방향만 마이크 enable.
 * 동시에 양쪽 trakck.enabled를 토글하므로 한 마이크가 두 세션에 동시 입력되는 일은 없다.
 */
function startTalk(direction) {
  if (!sessions.meToPartner || !sessions.partnerToMe) return;
  if (activeDirection) return;

  activeDirection = direction;

  const active = sessions[direction];
  const inactive = direction === 'meToPartner' ? sessions.partnerToMe : sessions.meToPartner;

  // 방향 게이팅: 활성 sender에만 합성 송신 트랙 연결, 반대편은 끊음
  active.sender.replaceTrack(active.outboundTrack);
  inactive.sender.replaceTrack(null);

  // VAD 시작 — 게이트(GainNode) 1로 두고 RMS 모니터링 시작
  startVAD();

  // 새 발화 시작 → 이전 자막 정리 (양방향 모두)
  // 페이드 아웃 진행 중이던 것도 즉시 제거되어 화면이 깨끗해진다.
  clearSubtitlesFor('meToPartner');
  clearSubtitlesFor('partnerToMe');

  const btn = direction === 'meToPartner' ? els.pttMe : els.pttPartner;
  btn.classList.add('is-active');
  // 활성 방향에 따라 해당 패널도 강조
  if (direction === 'meToPartner') {
    els.panelMe.classList.add('is-active');
    els.panelPartner.classList.remove('is-active');
  } else {
    els.panelPartner.classList.add('is-active');
    els.panelMe.classList.remove('is-active');
  }
  setStatus(direction === 'meToPartner' ? '듣는 중' : '듣는 중', 'listening');
  haptic(15);
}

/**
 * 손을 떼면:
 * 1. 마이크 입력은 즉시 음소거 (더 이상 새로운 말은 안 보냄)
 * 2. 하지만 트랙 연결과 데이터 채널은 잠시 유지 → OpenAI의 마지막 통역 결과 수신
 * 3. 자막이 흘러나오는 중이면 자동으로 더 기다림 (최대 GRACE_MAX_MS)
 * 4. 통역 결과가 완료되거나 일정 시간 활동이 없으면 트랙 해제
 */
const GRACE_MIN_MS = 1200;   // 손 뗀 후 최소 대기
const GRACE_MAX_MS = 6000;   // 손 뗀 후 최대 대기 (안전장치)
const GRACE_IDLE_MS = 800;   // 마지막 델타 이후 이만큼 조용하면 끝낸 걸로 간주

function stopTalk() {
  if (!activeDirection) return;

  const direction = activeDirection;
  const active = sessions[direction];
  activeDirection = null;

  // VAD 중지 — 게이트 복귀, 모니터링 종료
  stopVAD();
  // 송신 게이트를 즉시 0으로 — 그레이스 기간 동안 새로 흘러가는 입력 차단
  applyGain(0);

  // 2) UI는 곧바로 "통역 마무리 중" 상태로
  els.pttMe.classList.remove('is-active');
  els.pttPartner.classList.remove('is-active');
  els.panelMe.classList.remove('is-active');
  els.panelPartner.classList.remove('is-active');
  els.pttMe.disabled = true;
  els.pttPartner.disabled = true;
  setStatus('마무리 중', 'ok');
  haptic(8);

  if (!active) {
    finishGrace();
    return;
  }

  // 3) 트레일링 그레이스: 자막/오디오가 들어오는 동안 트랙 유지
  const releasedAt = Date.now();
  // 손 뗀 시각을 기준으로 활동 카운터를 새로 시작
  active.state.lastDeltaAt = Math.max(active.state.lastDeltaAt, releasedAt);

  const timer = setInterval(() => {
    const now = Date.now();
    const elapsed = now - releasedAt;
    const idle = now - active.state.lastDeltaAt;

    const shouldStop =
      // 최대 시간 초과 (안전장치)
      elapsed >= GRACE_MAX_MS ||
      // output_transcript.completed 받았고 최소 시간 지났으면 끝
      (active.state.completed && elapsed >= GRACE_MIN_MS) ||
      // 최소 대기 지났고, 마지막 델타 이후 충분히 조용하면 끝
      (elapsed >= GRACE_MIN_MS && idle >= GRACE_IDLE_MS);

    if (shouldStop) {
      clearInterval(timer);
      try { active.sender.replaceTrack(null); } catch {}
      // 발화 끝났으니 잠시 후 자막 자동 정리
      scheduleFadeOutForDirection(direction);
      finishGrace();
    }
  }, 100);
}

function finishGrace() {
  els.pttMe.disabled = false;
  els.pttPartner.disabled = false;
  setStatus('준비', 'ok');
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
  setStatus('재연결 중');
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
    // 사용자 제스처 안에서 AudioContext 초기화/resume — 라우드스피커 출력 활성화
    try {
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
    } catch {}
    try {
      await initSessions();
    } catch (err) {
      console.error(err);
      setStatus(`오류: ${err.message}`, 'error');
    }
  };
  document.addEventListener('click', bootstrap, { once: false });
  document.addEventListener('touchstart', bootstrap, { once: false });

  setStatus('화면을 탭하세요');

  // 서비스워커 등록
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  }
}

init();
