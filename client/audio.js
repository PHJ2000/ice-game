window.Game = window.Game || {};

window.Game.Audio = (() => {
  let audioReady = false;
  let audioContext;
  let masterGain;
  let bgm;
  let muted = false;

  const STORAGE_KEY = "ice-game-muted";

  const loadMuteSetting = () => {
    try {
      muted = localStorage.getItem(STORAGE_KEY) === "1";
    } catch (error) {
      muted = false;
    }
  };

  const saveMuteSetting = () => {
    try {
      localStorage.setItem(STORAGE_KEY, muted ? "1" : "0");
    } catch (error) {
      // ignore storage errors
    }
  };

  const initAudio = () => {
    if (muted) return;
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioContext.createGain();
      masterGain.gain.value = 0.35;
      masterGain.connect(audioContext.destination);
    }
    if (audioContext.state === "suspended") {
      audioContext.resume();
    }
    if (!audioReady) {
      audioReady = true;
      if (!bgm) {
        bgm = new Audio("assets/first_light_particles.wav");
        bgm.loop = true;
        bgm.volume = 0.5;
      }
      bgm.play().catch(() => {});
    }
  };

  const playTone = (frequency, duration = 0.1, volume = 0.2) => {
    if (!audioReady || muted) return;
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency;
    gain.gain.value = volume;
    osc.connect(gain).connect(masterGain);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + duration);
    osc.stop(audioContext.currentTime + duration);
  };

  const setMuted = (value) => {
    muted = Boolean(value);
    if (muted) {
      if (bgm) {
        bgm.pause();
      }
    } else if (audioReady) {
      if (bgm) {
        bgm.play().catch(() => {});
      }
    }
    saveMuteSetting();
  };

  const toggleMute = () => {
    setMuted(!muted);
    return muted;
  };

  loadMuteSetting();

  return {
    initAudio,
    playWall: () => playTone(360, 0.08, 0.12),
    playPaddle: () => playTone(520, 0.09, 0.18),
    playGoal: () => playTone(220, 0.22, 0.3),
    isMuted: () => muted,
    setMuted,
    toggleMute,
  };
})();
