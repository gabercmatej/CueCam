# OBS setup (macOS): Skillcam into FaceTime / WhatsApp

Skillcam renders the call video into a window titled **Skillcam Output** (exactly 1920×1080 real pixels, frameless, no UI). OBS captures that window and republishes it as **OBS Virtual Camera**, which call apps can select like a webcam.

**Image quality chain:** camera at its native 1920×1080 / 30 fps → Skillcam draws it 1:1 into a 1920×1080 canvas → OBS captures exactly those pixels → OBS Virtual Camera at 1920×1080 → the call app. Nothing in that chain should scale. The call app still compresses the video for the network, so the far side never sees quite the raw camera, but each step before it is now lossless in size.

One-time setup takes about 5 minutes. Tested path: OBS Studio 30+ on macOS 14/15.

## 1. Install OBS and grant permissions

1. Install OBS Studio from <https://obsproject.com> (or `brew install --cask obs`).
2. Start OBS. When macOS asks, allow **Screen & System Audio Recording** for OBS: System Settings → Privacy & Security → Screen & System Audio Recording → enable OBS. Quit and reopen OBS after granting it.
3. Skip the auto-configuration wizard, or choose "Optimize just for virtual camera".

## 2. Match the canvas to Skillcam

Settings → Video:
- **Base (Canvas) Resolution:** 1920x1080
- **Output (Scaled) Resolution:** 1920x1080 (the same: no scaling, so the downscale filter never applies)
- **Common FPS Values:** 30 (the camera's rate; 60 would only duplicate frames)

Settings → Advanced → Video (the defaults, check they weren't changed):
- **Color Format:** NV12 · **Color Space:** Rec. 709 · **Color Range:** Limited

If Skillcam is set to `"video": { "outputHeight": 720 }` (a slower Mac), use 1280x720 for both resolutions instead.

## 3. Add the Skillcam Output window

1. Start Skillcam (the app, or `npm run dev`) so the Output window exists.
2. In OBS, Sources → **+** → **macOS Screen Capture** → name it "Skillcam" → OK.
3. Method: **Window Capture**. Window: **Skillcam Output**. The app lists it as `[Skillcam] Skillcam Output`; with `npm run dev` it's under the name "Electron": `[Electron] Skillcam Output`.
4. Untick **Show Window Shadow** if the option is there. Leave **Hide cursor** ticked.
5. Click OK.

**Check the size, don't scale:**
- The window is sized so it holds exactly 1920×1080 real pixels on the display it's on (a 960×540 pt window on a Retina screen; it re-sizes itself if you drag it to a non-Retina monitor). The source should fill the 1920×1080 canvas exactly at 100%: right-click the source → **Transform → Edit Transform** should show size 1920×1080 and scale 1.0. If it doesn't, use **Transform → Reset Transform** rather than stretching it.
- Older setups (from Phase 2) had the source scaled with "Fit to Screen". Reset that transform: the old 1280×720 canvas was captured at 2560×1440 and scaled down, which blurred it.
- If an edge shows a sliver of desktop or a title-bar line, hold ⌥ and drag that edge of the source inward to crop it. Or use right-click → Transform → Edit Transform → Crop.
- On a 1× (non-Retina) monitor the window is 1920×1080 points, larger than many screens. Keep it on the Retina display, or set `outputHeight` to 720.
- Don't flip or mirror the source. The Output is deliberately unmirrored, so text reads correctly to the other side. Call apps mirror only your own self-view.

The Output window can sit behind other windows; OBS still captures it. Don't minimize it, though: a minimized window stops rendering.

## 4. Start the virtual camera

1. In the Controls dock, click **Start Virtual Camera**.
2. **First time only:** macOS asks to allow the OBS system extension.
   - macOS 15+: System Settings → General → **Login Items & Extensions** → Camera Extensions (ⓘ) → enable **OBS Virtual Camera**.
   - macOS 13–14: System Settings → Privacy & Security → scroll to "System software from application 'OBS' was blocked" → **Allow**, enter your password.
   - Then click Start Virtual Camera again. A restart of OBS (rarely, of the Mac) may be needed the first time.
3. Fully quit and reopen any call app that was running, so it picks up the new camera.

## 5. Pick the camera in the call app

- **FaceTime:** menu bar **Video → OBS Virtual Camera** (works before or during a call).
- **WhatsApp (Mac app):** during a video call, click the camera options (⌄ or ⋯ next to the camera button) → **OBS Virtual Camera**. Or go to Settings → Calls/Video → Camera beforehand.
- Use **headphones**, so the other person's voice can't trigger your speech words.

**Skillcam never uses OBS Virtual Camera as its own input.** macOS lists it first once OBS is installed, so the system default camera is OBS's output, a feedback loop of re-encoded frames. Skillcam picks the first real camera instead and logs which one (`[camera] "MacBook Air Camera" granted 1920×1080 @ 30 fps`). To choose another camera, set part of its name in `skillcam.config.json`: `"video": { "camera": "iPhone" }`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Skillcam Output" not in the window list | Start Skillcam first, then reopen the source's properties. Check OBS's Screen Recording permission. |
| Black source | Screen Recording permission missing or OBS not restarted after granting it. |
| Picture frozen while the call app is in front | Make sure the Output window isn't minimized. Skillcam disables Chromium's occlusion throttling and App Nap; if it still freezes, report it with the Control window's numbers. |
| No "OBS Virtual Camera" in the call app | The extension isn't approved yet (step 4.2), or the call app was open before the camera started: quit it fully (⌘Q) and reopen. |
| Picture looks mirrored to the other person | It shouldn't be. Check that the OBS source has no flip transform. FaceTime's self-view is mirrored only on your side. |
| Laggy / low fps | Watch the Control window: render fps, per-stage ms and the quality level. Skillcam steps quality down by itself under load. OBS at 1920×1080 / 30 fps with no scaling keeps capture cheap. |
| Picture soft or blurry | The OBS source is scaled: Transform → Reset Transform (it should be 1920×1080 at scale 1.0), and Base = Output resolution. Check the Skillcam log line `[camera] … granted 1920×1080`: if the camera granted less, it's the camera's limit. |
| Skillcam shows the OBS picture, or a mirror-in-mirror | Skillcam picked OBS Virtual Camera as its input. It shouldn't; set `"video": { "camera": "MacBook" }` (or your camera's name) and restart. |
