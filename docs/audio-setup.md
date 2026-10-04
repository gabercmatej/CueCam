# Audio setup: your voice and effect sounds in the call

Skillcam can send your voice mixed with its effect sounds into FaceTime, WhatsApp, Zoom or any other
call app. It does this through **BlackHole 2ch**, a free virtual audio device: Skillcam plays the mix
into BlackHole, and the call app uses BlackHole as its microphone.

```
your mic ──► Skillcam ──► mix (voice + effect sounds) ──► BlackHole 2ch ──► call app "microphone"
                │
                └──► effect sounds only, quietly ──► your headphones (monitor)
```

Use **headphones**. Without them the call's sound comes out of your speakers, into your mic, and back to
the other person as an echo (Skillcam sends your mic unprocessed, see below).

## 1. Install BlackHole 2ch

1. Install it: `brew install blackhole-2ch`, or the installer from <https://existential.audio/blackhole/>.
2. **Restart Core Audio** so macOS sees the new device. Either restart the Mac, or run
   `sudo killall coreaudiod` in Terminal (your sound cuts out for a second).
3. Check: System Settings → Sound → Output and Input both list **BlackHole 2ch**. Leave your system
   output on your headphones/speakers. Skillcam picks BlackHole by itself.

## 2. Skillcam

Call audio is on by default. The Control window shows:

- `call ON → BlackHole 2ch`: it is sending. `"BlackHole" not found`: BlackHole isn't installed or Core
  Audio wasn't restarted. Skillcam then works as before (effect sounds play locally, no call audio).
- **send to call**: the switch. Off sends nothing (the call hears silence from BlackHole).
- **monitor**: how loud you hear the effect sounds yourself (default 30%). 0 turns it off. You never
  hear your own voice from Skillcam.
- The **mic** and **mix** meters. The mix meter moves when you talk: that's what the call receives.

Settings in `skillcam.config.json` (all optional; hot-reloaded):

```json
"audio": {
  "volume": 1,
  "device": "AirPods",
  "call": { "enabled": true, "device": "BlackHole", "micVolume": 1, "monitor": true, "monitorVolume": 0.3 }
}
```

`device` is your local output (and the monitor). `call.device` is matched by part of its name.

## 3. FaceTime

1. Start or join a call.
2. Menu bar → **Video** → **Microphone** → **BlackHole 2ch**.
3. Control Centre → **Mic Mode** → **Standard** or **Wide Spectrum**. **Not Voice Isolation**: it treats
   effect sounds as background noise and removes them.

## 4. WhatsApp (Mac app)

1. WhatsApp → Settings → **Calls** (or, during a call, the **⋯** / device menu).
2. **Microphone** → **BlackHole 2ch**. Keep **Speaker/Output** on your headphones.
3. Mic Mode (Control Centre, during the call) → **Standard** or **Wide Spectrum**, not Voice Isolation.

Other apps (Zoom, Meet, Teams): choose BlackHole 2ch as the microphone in their audio settings. Turn off
their own "suppress background noise" if effect sounds get cut, or set it to low.

## Why the mic is sent unprocessed

Skillcam turns off echo cancellation, noise suppression and auto gain on the mic it sends:

- The call app already does all three on its microphone input (here, BlackHole). Doing them twice makes
  your voice pump in volume and sound warbly, and the second echo canceller has nothing correct to work
  against.
- Chromium's processing works in 10 ms blocks, which adds delay.
- With headphones there is no echo to cancel.

Speech recognition and the clap detector listen to the mic directly, never to the mix, so effect sounds
can't trigger words or claps.

## Troubleshooting

- **The other person hears nothing:** the call app's microphone isn't BlackHole 2ch, or "send to call"
  is off. Talk and watch the mix meter in Control.
- **They hear an echo of themselves:** you're on speakers. Use headphones.
- **Effect sounds are cut off or very quiet for them:** Mic Mode is Voice Isolation, or the app's noise
  suppression is high.
- **BlackHole missing after installing:** restart the Mac or run `sudo killall coreaudiod`.
- **Your voice is too quiet/loud for them:** `audio.call.micVolume` (1 = unchanged). The call app's own
  auto gain usually evens it out.
