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
  meHint: document.getElementById('meHint'),
  partnerHint: document.getElementById('partnerHint'),
  vizMe: document.getElementById('vizMe'),
  vizPartner: document.getElementById('vizPartner'),
  audioMeToPartner: document.getElementById('audioMeToPartner'),
  audioPartnerToMe: document.getElementById('audioPartnerToMe'),
};

function setHint(side, text) {
  const el = side === 'me' ? els.meHint : els.partnerHint;
  if (!el) return;
  el.querySelector('.hint-text').textContent = text;
}

function setButtonLabel(side, text) {
  const el = side === 'me' ? els.pttMeLabel : els.pttPartnerLabel;
  if (el) el.textContent = text;
}

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
  ctx: null,
  source: null,
  analyser: null,
  gate: null,
  // 두 PC가 같은 MediaStreamTrack 인스턴스를 공유하면 일부 모바일 WebRTC 구현에서
  // 두 번째 PC가 RTP를 보내지 못하는 케이스가 있다.
  // → 게이트(GainNode) 출력에 MediaStreamDestination을 둘 두고 각 PC에 별도 트랙을 준다.
  destA: null, trackA: null,   // 첫 번째 세션용
  destB: null, trackB: null,   // 두 번째 세션용
  buf: null,
};

function buildAudioPipeline() {
  if (audioPipeline.trackA && audioPipeline.trackB) return audioPipeline;
  if (!micStream) throw new Error('마이크 스트림이 없습니다.');

  const ctx = getVadContext();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  const source = ctx.createMediaStreamSource(micStream);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.4;
  source.connect(analyser);

  const gate = ctx.createGain();
  gate.gain.value = 1;
  source.connect(gate);

  // 두 개의 destination — 각 PC가 자기 트랙을 갖게
  const destA = ctx.createMediaStreamDestination();
  const destB = ctx.createMediaStreamDestination();
  gate.connect(destA);
  gate.connect(destB);

  const trackA = destA.stream.getAudioTracks()[0];
  const trackB = destB.stream.getAudioTracks()[0];

  audioPipeline = {
    ctx, source, analyser, gate,
    destA, trackA, destB, trackB,
    buf: new Float32Array(analyser.fftSize),
  };
  return audioPipeline;
}

function destroyAudioPipeline() {
  try { audioPipeline.source?.disconnect(); } catch {}
  try { audioPipeline.analyser?.disconnect(); } catch {}
  try { audioPipeline.gate?.disconnect(); } catch {}
  try { audioPipeline.destA?.disconnect(); } catch {}
  try { audioPipeline.destB?.disconnect(); } catch {}
  audioPipeline = {
    ctx: null, source: null, analyser: null, gate: null,
    destA: null, trackA: null, destB: null, trackB: null, buf: null,
  };
}

/* ============================================
   VAD — 자동 종료 타이머 전용
   ============================================
   탭 토글 모드에서는 마이크를 중간에 게이팅하지 않는다.
   (게이팅이 다시 풀릴 때 자기 통역 음성을 입력으로 잡아 에코가 발생했음)

   대신 VAD는 한 가지 일만 함: 5초 이상 침묵이 지속되면 발화 자동 종료.
*/
const VAD_AUTO_END_MS = 5000;   // 이 시간 이상 조용하면 자동 종료
const VAD_CHECK_INTERVAL = 100;
const VAD_THRESHOLD = 0.018;
const VAD_RAMP_MS = 40;

let vad = {
  timer: null,
  lastVoiceAt: 0,
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
  applyGain(1);

  vad.timer = setInterval(() => {
    if (!activeDirection) return;
    audioPipeline.analyser.getFloatTimeDomainData(audioPipeline.buf);

    let sum = 0;
    const buf = audioPipeline.buf;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);

    const now = Date.now();
    if (rms > VAD_THRESHOLD) {
      vad.lastVoiceAt = now;
    } else if (now - vad.lastVoiceAt >= VAD_AUTO_END_MS) {
      // 5초간 조용함 → 발화 자동 종료
      console.log('[VAD] 자동 종료 (5초 침묵)');
      stopTalk();
    }
  }, VAD_CHECK_INTERVAL);
}

function stopVAD() {
  if (vad.timer) {
    clearInterval(vad.timer);
    vad.timer = null;
  }
  applyGain(1);
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
  // (1) iOS 안전장치
  try {
    sinkEl.srcObject = stream;
    sinkEl.muted = true;
    sinkEl.playsInline = true;
    sinkEl.setAttribute('playsinline', '');
    sinkEl.play?.().catch(() => {});
  } catch {}

  // (2) AudioContext 경로로 재생 + analyser tap
  try {
    const ctx = getAudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = 1.6;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.7;
    // src -> gain -> destination (들리는 경로)
    // src -> analyser (시각화 분기)
    src.connect(gain);
    gain.connect(ctx.destination);
    src.connect(analyser);
    return analyser;
  } catch (err) {
    console.warn('AudioContext routing 실패, srcObject 폴백:', err);
    try {
      sinkEl.muted = false;
      sinkEl.play?.().catch(() => {});
    } catch {}
    return null;
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
 * onSpeakingStart/End: 통역 음성 출력 시작/종료 신호 (UI 큐용)
 */
async function openSession({ targetLanguage, outboundTrack, audioOut, onSpeakingStart, onSpeakingEnd }) {
  const clientSecret = await fetchClientSecret(targetLanguage);

  const pc = new RTCPeerConnection();
  const events = pc.createDataChannel('oai-events');

  // 세션 상태 (트레일링 그레이스 판단용)
  const state = {
    lastDeltaAt: 0,            // 마지막으로 자막/오디오 델타가 도착한 시각 (ms)
    outputCompletedAt: 0,      // output_transcript.completed 받은 시각
    completed: false,          // 마지막 발화에 대한 결과를 모두 받았는지
    speaking: false,           // 통역 음성 출력 중인지
    outputAnalyser: null,      // 출력 음성 시각화용 AnalyserNode
  };
  const markActivity = () => {
    state.lastDeltaAt = Date.now();
    state.completed = false;
  };

  // 번역된 오디오 수신 + 시각화용 analyser
  pc.ontrack = ({ streams }) => {
    if (!streams || !streams[0]) return;
    state.outputAnalyser = routeToLoudspeaker(streams[0], audioOut);
  };

  // 송신 트랙 추가. PTT 비활성 상태에서는 replaceTrack(null)로 송신 끊을 예정.
  // 트랙 자체는 enabled를 토글하지 않는다 (RMS 측정/게이팅이 항상 가능해야 하므로).
  const sender = pc.addTrack(outboundTrack);

  // 통역 음성 출력 중인지 트래킹 (UI 큐용)
  let speakingTimer = null;
  const markSpeakingTick = () => {
    if (!state.speaking) {
      state.speaking = true;
      onSpeakingStart?.();
    }
    if (speakingTimer) clearTimeout(speakingTimer);
    speakingTimer = setTimeout(() => {
      state.speaking = false;
      onSpeakingEnd?.();
    }, 600);
  };

  events.addEventListener('message', (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }
    if (evt.type === 'session.output_audio.delta') {
      markActivity();
      markSpeakingTick();
    }
    if (evt.type === 'session.output_transcript.delta') {
      markActivity();
    }
    if (evt.type === 'session.output_transcript.completed') {
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
      outboundTrack: pipeline.trackA, // 첫 번째 PC용 전용 트랙
      audioOut: els.audioMeToPartner,
      onSpeakingStart: () => onSpeaking('partner', true),
      onSpeakingEnd: () => onSpeaking('partner', false),
    }),
    openSession({
      targetLanguage: myLang,
      outboundTrack: pipeline.trackB, // 두 번째 PC용 전용 트랙
      audioOut: els.audioPartnerToMe,
      onSpeakingStart: () => onSpeaking('me', true),
      onSpeakingEnd: () => onSpeaking('me', false),
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
   음파 시각화 (Canvas)
   ============================================ */

const VIZ_BARS = 32;          // 막대 개수
const VIZ_MIN_BAR = 0.04;     // 무음일 때 막대 최소 높이 (살짝 살아있는 느낌)

const visualizers = [
  // me 패널 — 위쪽에서 보면 아래쪽 (panel--bottom)
  { canvas: null, ctx: null, color: '#5b8cff', side: 'me' },
  // partner 패널 — 위쪽 panel (panel--top, 180도 회전됨)
  { canvas: null, ctx: null, color: '#c79dff', side: 'partner' },
];

function initVisualizers() {
  visualizers[0].canvas = els.vizMe;
  visualizers[1].canvas = els.vizPartner;
  for (const v of visualizers) {
    // 디바이스 픽셀비 적용
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = v.canvas.getBoundingClientRect();
    v.canvas.width = Math.floor(rect.width * dpr);
    v.canvas.height = Math.floor(rect.height * dpr);
    v.ctx = v.canvas.getContext('2d');
    v.ctx.scale(dpr, dpr);
    v.cssW = rect.width;
    v.cssH = rect.height;
  }
  if (!visualizers._raf) {
    visualizers._raf = requestAnimationFrame(tickViz);
  }
}

/**
 * 어느 analyser를 그릴지 결정.
 * - 활성 PTT 패널 → 마이크 입력 (audioPipeline.analyser)
 * - 통역 음성 출력 중인 패널 → 해당 세션의 outputAnalyser
 * - 둘 다 아님 → null (잔잔한 라인 그림)
 */
function pickAnalyserForSide(side) {
  const panel = side === 'me' ? els.panelMe : els.panelPartner;

  // 통역 음성이 흘러나오는 패널: 출력 analyser 사용
  if (panel.classList.contains('is-speaking')) {
    // me 패널에는 partnerToMe 세션의 출력이 흐름 (상대→나 통역)
    // partner 패널에는 meToPartner 세션의 출력이 흐름 (나→상대 통역)
    const session = side === 'me' ? sessions.partnerToMe : sessions.meToPartner;
    return session?.state?.outputAnalyser || null;
  }

  // 활성 PTT 패널: 마이크 입력 사용
  if (panel.classList.contains('is-active')) {
    return audioPipeline.analyser;
  }

  return null;
}

const _vizBuf = new Float32Array(512);

function drawViz(v, analyser) {
  const ctx = v.ctx;
  const w = v.cssW;
  const h = v.cssH;

  // 페이드 클리어 (잔상 효과)
  ctx.clearRect(0, 0, w, h);

  const bars = VIZ_BARS;
  const gap = 3;
  const barW = (w - gap * (bars - 1)) / bars;
  const cy = h / 2;

  // 막대 높이 계산
  const heights = new Array(bars).fill(VIZ_MIN_BAR);
  if (analyser) {
    analyser.getFloatTimeDomainData(_vizBuf);
    const samplesPerBar = Math.floor(_vizBuf.length / bars);
    for (let i = 0; i < bars; i++) {
      let sum = 0;
      const start = i * samplesPerBar;
      const end = start + samplesPerBar;
      for (let j = start; j < end; j++) {
        const s = _vizBuf[j];
        sum += s * s;
      }
      const rms = Math.sqrt(sum / samplesPerBar);
      // 부드러운 증폭 (sqrt) + 상한
      heights[i] = Math.min(1, Math.max(VIZ_MIN_BAR, Math.pow(rms * 4, 0.7)));
    }
  } else {
    // 비활성 상태에서도 살짝 움직임 (정적 라인)
    const t = performance.now() / 1000;
    for (let i = 0; i < bars; i++) {
      heights[i] = VIZ_MIN_BAR + Math.sin(t * 1.2 + i * 0.4) * 0.012;
    }
  }

  // 그라데이션
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, v.color);
  grad.addColorStop(1, v.color + '55');
  ctx.fillStyle = grad;

  // 막대 그리기 (가운데 정렬)
  for (let i = 0; i < bars; i++) {
    const x = i * (barW + gap);
    const barH = Math.max(2, heights[i] * h * 0.85);
    const y = cy - barH / 2;
    const r = Math.min(barW / 2, 3);
    roundedRect(ctx, x, y, barW, barH, r);
  }
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

function tickViz() {
  for (const v of visualizers) {
    if (!v.ctx) continue;
    drawViz(v, pickAnalyserForSide(v.side));
  }
  visualizers._raf = requestAnimationFrame(tickViz);
}

window.addEventListener('resize', () => {
  // 리사이즈 시 캔버스 재설정
  for (const v of visualizers) {
    if (!v.canvas) continue;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = v.canvas.getBoundingClientRect();
    if (rect.width === 0) continue;
    v.canvas.width = Math.floor(rect.width * dpr);
    v.canvas.height = Math.floor(rect.height * dpr);
    v.ctx = v.canvas.getContext('2d');
    v.ctx.scale(dpr, dpr);
    v.cssW = rect.width;
    v.cssH = rect.height;
  }
});

/* ============================================
   힌트 영역 상태 큐 관리
   ============================================
   - 어느 패널이 활성(PTT 눌림)인지
   - 어느 패널에서 통역 음성이 나오는 중인지
   에 따라 .is-active / .is-speaking 클래스를 토글하고 안내 텍스트를 갱신한다.
*/

function defaultHints() {
  setHint('me', '파란색 버튼을 탭해서 시작');
  setHint('partner', '보라색 버튼을 탭해서 시작');
}

function onSpeaking(side, isStart) {
  const panel = side === 'me' ? els.panelMe : els.panelPartner;
  if (isStart) {
    panel.classList.add('is-speaking');
    setHint(side, '통역 중…');
  } else {
    panel.classList.remove('is-speaking');
    if (!panel.classList.contains('is-active')) {
      const text = side === 'me'
        ? '파란색 버튼을 탭해서 시작'
        : '보라색 버튼을 탭해서 시작';
      setHint(side, text);
    }
  }
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

  startVAD();

  const btn = direction === 'meToPartner' ? els.pttMe : els.pttPartner;
  btn.classList.add('is-active');
  if (direction === 'meToPartner') {
    els.panelMe.classList.add('is-active');
    els.panelPartner.classList.remove('is-active');
    setHint('me', '말씀하세요 · 다시 탭하면 종료');
    setButtonLabel('me', '멈춤');
  } else {
    els.panelPartner.classList.add('is-active');
    els.panelMe.classList.remove('is-active');
    setHint('partner', '말씀하세요 · 다시 탭하면 종료');
    setButtonLabel('partner', '멈춤');
  }
  setStatus('듣는 중', 'listening');
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
  // 통역 중 표시(.is-speaking)는 그대로 두고, 출력이 끝날 때 onSpeakingEnd가 정리.
  // 입력 쪽 힌트(말씀하세요)는 즉시 기본으로 복귀
  // 라벨 복귀 (언어 이름으로)
  const my = els.myLang.value;
  const partner = els.partnerLang.value;
  setButtonLabel('me', LANG_TO_SHORT[my] || my.toUpperCase());
  setButtonLabel('partner', LANG_TO_SHORT[partner] || partner.toUpperCase());

  if (direction === 'meToPartner' && !els.panelMe.classList.contains('is-speaking')) {
    setHint('me', '파란색 버튼을 탭해서 시작');
  }
  if (direction === 'partnerToMe' && !els.panelPartner.classList.contains('is-speaking')) {
    setHint('partner', '보라색 버튼을 탭해서 시작');
  }
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
/**
 * 탭 토글 방식:
 * - 한 번 탭 → 그 방향 녹음 시작
 * - 같은 버튼 다시 탭 → 종료
 * - 다른 쪽 버튼 탭 → 자동 화자 전환 (이전 끄고 새로 시작)
 * - 5초 침묵 → 자동 종료
 */
function bindPTT(btn, direction) {
  const onClick = (e) => {
    e.preventDefault();
    if (activeDirection === direction) {
      // 같은 버튼 다시 탭 → 종료
      stopTalk();
    } else if (activeDirection) {
      // 다른 쪽이 활성 중 → 화자 전환
      switchTalk(direction);
    } else {
      startTalk(direction);
    }
  };

  btn.addEventListener('click', onClick);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('selectstart', (e) => e.preventDefault());
  btn.addEventListener('dragstart', (e) => e.preventDefault());
}

/**
 * 활성 방향을 바꿔서 다른 사람 차례로 즉시 전환.
 * stopTalk의 그레이스(통역 마무리)를 기다리지 않고 바로 새 발화 시작.
 */
function switchTalk(newDirection) {
  if (!sessions.meToPartner || !sessions.partnerToMe) return;
  if (activeDirection === newDirection) return;

  // 이전 방향 정리 (그레이스 짧게)
  const prev = activeDirection;
  if (prev) {
    activeDirection = null;
    stopVAD();
    applyGain(0);
    try { sessions[prev].sender.replaceTrack(null); } catch {}
    els.pttMe.classList.remove('is-active');
    els.pttPartner.classList.remove('is-active');
    els.panelMe.classList.remove('is-active');
    els.panelPartner.classList.remove('is-active');
  }

  // 즉시 새 방향 시작
  startTalk(newDirection);
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

/* ============================================
   라이프사이클: 백그라운드 진입 시 마이크/세션 완전 해제
   ============================================
   폰 뒤로가기/홈 누름 → visibilitychange(hidden) 또는 pagehide.
   이때 마이크 트랙을 stop()으로 진짜 풀어줘야 다른 앱이 마이크 사용 가능.
   복귀 시 사용자 제스처 한 번으로 재초기화.
*/

let isTornDown = false; // 마이크/세션이 해제된 상태인지

function tearDown(reason = 'background') {
  console.log('[lifecycle] teardown:', reason);
  isTornDown = true;
  // 진행 중인 PTT를 정리
  try { stopTalk(); } catch {}

  // VAD 중지
  try { stopVAD(); } catch {}

  // 세션 닫기
  try { sessions.meToPartner?.pc.close(); } catch {}
  try { sessions.partnerToMe?.pc.close(); } catch {}
  sessions.meToPartner = null;
  sessions.partnerToMe = null;

  // 오디오 파이프라인(GainNode 등) 해제
  try { destroyAudioPipeline(); } catch {}

  // 마이크 트랙 진짜 해제 (브라우저가 마이크 인디케이터 끔, OS가 풀어줌)
  if (micStream) {
    try { micStream.getTracks().forEach((t) => t.stop()); } catch {}
    micStream = null;
  }

  // AudioContext 일시정지 (CPU/배터리 절약)
  try { if (outputCtx && outputCtx.state === 'running') outputCtx.suspend(); } catch {}
  try { if (vadCtx && vadCtx.state === 'running') vadCtx.suspend(); } catch {}

  // UI 리셋
  els.pttMe.disabled = true;
  els.pttPartner.disabled = true;
  els.pttMe.classList.remove('is-active');
  els.pttPartner.classList.remove('is-active');
  els.panelMe.classList.remove('is-active', 'is-speaking');
  els.panelPartner.classList.remove('is-active', 'is-speaking');
  updateLangBadges();
  defaultHints();
  setStatus('화면을 탭하세요');
}

let bootstrapping = false;
async function bootstrap() {
  if (bootstrapping) return;
  if (!isTornDown && (sessions.meToPartner || sessions.partnerToMe)) return; // 이미 살아있음
  bootstrapping = true;
  isTornDown = false;
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
  } catch {}
  try {
    const v = getVadContext();
    if (v.state === 'suspended') await v.resume();
  } catch {}
  try {
    await initSessions();
  } catch (err) {
    console.error(err);
    setStatus(`오류: ${err.message}`, 'error');
  } finally {
    bootstrapping = false;
  }
}

function init() {
  updateLangBadges();
  defaultHints();
  initVisualizers();
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

  // 최초/복귀 사용자 제스처로 세션 시작
  const onUserGesture = () => bootstrap();
  document.addEventListener('click', onUserGesture);
  document.addEventListener('touchstart', onUserGesture);

  // 백그라운드/포그라운드 라이프사이클
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      tearDown('hidden');
    }
    // 복귀(visible)는 사용자가 화면 탭하면 onUserGesture가 bootstrap 호출
  });
  // pagehide는 PWA가 백그라운드로 갈 때, freeze될 때 등 더 광범위
  window.addEventListener('pagehide', () => tearDown('pagehide'));
  // 명시적인 뒤로가기 / 새로고침 / 닫기 시도
  window.addEventListener('beforeunload', () => tearDown('unload'));

  setStatus('화면을 탭하세요');

  // 서비스워커 등록 — 페이지 로드 후 즉시 (PWA 설치 가능 판정용)
  if ('serviceWorker' in navigator) {
    const reg = () => {
      navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
        .then((r) => console.log('[SW] registered, scope:', r.scope))
        .catch((err) => console.warn('[SW] register failed:', err));
    };
    if (document.readyState === 'complete') reg();
    else window.addEventListener('load', reg, { once: true });
  }

  // PWA 설치 프롬프트 캐치 — 가능하면 사용자에게 안내
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    console.log('[PWA] beforeinstallprompt captured');
    // TODO: 화면에 "설치하기" 버튼 표시 (필요 시)
  });
  window.addEventListener('appinstalled', () => {
    console.log('[PWA] app installed');
    deferredInstallPrompt = null;
  });
}

let deferredInstallPrompt = null;
window.installPWA = async function () {
  if (!deferredInstallPrompt) {
    alert('설치 프롬프트가 아직 준비되지 않았어요. 페이지를 새로고침해보세요.');
    return;
  }
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  console.log('[PWA] install outcome:', outcome);
  deferredInstallPrompt = null;
};

init();
