// Short, soft cues for host decisions, so a busy guard notices without looking at the screen.
// Web Audio needs a prior user gesture; the guard has always typed or tapped by the time a decision lands.
let ctx;
function tone(freqs, dur = 0.13) {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    let t = ctx.currentTime;
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.16, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
      t += dur * 0.85;
    }
  } catch { /* audio unavailable: the toast still shows */ }
}

const vibrate = (p) => { try { navigator.vibrate?.(p); } catch { /* not supported */ } };

export const cue = {
  approved: () => { tone([660, 880]); vibrate([60, 40, 60]); },
  rejected: () => { tone([392, 262], 0.2); vibrate(220); },
  expired: () => { tone([523]); vibrate(80); },
};
