window.Game = window.Game || {};

window.Game.Audio = (() => {
  let audioReady = false;
  let audioContext;
  let masterGain;
  let bgm;
  let muted = false;
  let sfxReady = false;
  const sfx = { wall: null, paddle: null, goal: null, cheer: null };

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
    if (!sfxReady) {
      initSfx();
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

  const initSfx = () => {
    if (sfxReady || !window.sfxr || !window.Params) return;

    const paddle = new window.Params();
    paddle.wave_type = 0;
    paddle.p_base_freq = 0.55;
    paddle.p_env_sustain = 0.05;
    paddle.p_env_decay = 0.12;
    paddle.p_freq_ramp = -0.3;
    paddle.sound_vol = 0.25;

    const wall = new window.Params();
    wall.wave_type = 3;
    wall.p_base_freq = 0.2;
    wall.p_env_sustain = 0.04;
    wall.p_env_decay = 0.18;
    wall.p_lpf_freq = 0.6;
    wall.sound_vol = 0.2;

    const goal = new window.Params();
    goal.wave_type = 1;
    goal.p_base_freq = 0.6;
    goal.p_env_attack = 0.01;
    goal.p_env_sustain = 0.12;
    goal.p_env_decay = 0.25;
    goal.p_arp_mod = 0.35;
    goal.p_arp_speed = 0.25;
    goal.sound_vol = 0.3;

    const cheer = new window.Params();
    cheer.wave_type = 2;
    cheer.p_base_freq = 0.7;
    cheer.p_env_attack = 0.01;
    cheer.p_env_sustain = 0.2;
    cheer.p_env_decay = 0.3;
    cheer.p_freq_ramp = -0.1;
    cheer.sound_vol = 0.28;

    const makeSfx = (params, volume) => {
      const audio = window.sfxr.toAudio(params);
      if (!audio) return null;
      if (typeof audio.setVolume === "function") {
        audio.setVolume(volume);
        audio._volume = volume;
      } else {
        audio.volume = volume;
      }
      return audio;
    };

    sfx.paddle = makeSfx(paddle, 0.7);
    sfx.wall = makeSfx(wall, 0.6);
    sfx.goal = makeSfx(goal, 0.75);
    sfx.cheer = makeSfx(cheer, 0.75);
    sfxReady = true;
  };

  const playSfx = (audio) => {
    if (!audio || muted) return;
    if (typeof audio.cloneNode === "function") {
      const node = audio.cloneNode();
      node.volume = typeof audio.volume === "number" ? audio.volume : 1;
      node.play().catch(() => {});
      return;
    }
    if (typeof audio.setVolume === "function") {
      audio.setVolume(typeof audio._volume === "number" ? audio._volume : 1);
    }
    if (typeof audio.play === "function") {
      audio.play();
    }
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
    playWall: () => (sfx.wall ? playSfx(sfx.wall) : playTone(360, 0.08, 0.12)),
    playPaddle: () => (sfx.paddle ? playSfx(sfx.paddle) : playTone(520, 0.09, 0.18)),
    playGoal: () => (sfx.goal ? playSfx(sfx.goal) : playTone(220, 0.22, 0.3)),
    playCheer: () => (sfx.cheer ? playSfx(sfx.cheer) : playTone(740, 0.18, 0.24)),
    isMuted: () => muted,
    setMuted,
    toggleMute,
  };
})();
