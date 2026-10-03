# OBS setup (macOS): Skillcam into FaceTime / WhatsApp

Skillcam renders the call video into a window titled **Skillcam Output** (1280×720, frameless, no UI). OBS captures that window and republishes it as **OBS Virtual Camera**, which call apps can select like a webcam.

One-time setup takes about 5 minutes. Tested path: OBS Studio 30+ on macOS 14/15.

## 1. Install OBS and grant permissions

1. Install OBS Studio from <https://obsproject.com> (or `brew install --cask obs`).
2. Start OBS. When macOS asks, allow **Screen & System Audio Recording** for OBS: System Settings → Privacy & Security → Screen & System Audio Recording → enable OBS. Quit and reopen OBS after granting it.
3. Skip the auto-configuration wizard, or choose "Optimize just for virtual camera".

## 2. Match the canvas to Skillcam

Settings → Video:
- **Base (Canvas) Resolution:** 1280x720
- **Output (Scaled) Resolution:** 1280x720
- **Common FPS Values:** 30

## 3. Add the Skillcam Output window

1. Start Skillcam (`npm run dev`) so the Output window exists.
2. In OBS, Sources → **+** → **macOS Screen Capture** → name it "Skillcam" → OK.
3. Method: **Window Capture**. Window: **Skillcam Output**. In dev builds it may be listed under the app name "Electron": pick `[Electron] Skillcam Output`.
4. Untick **Show Window Shadow** if the option is there. Leave **Hide cursor** ticked.
5. Click OK.

**Fit and crop:**
- On a Retina Mac the window is captured at 2× (2560×1440). Right-click the source → **Transform → Fit to Screen** (⌘F). It should fill the canvas exactly, with no black bars.
- If an edge shows a sliver of desktop or a title-bar line, hold ⌥ and drag that edge of the source inward to crop it. Or use right-click → Transform → Edit Transform → Crop.
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

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Skillcam Output" not in the window list | Start Skillcam first, then reopen the source's properties. Check OBS's Screen Recording permission. |
| Black source | Screen Recording permission missing or OBS not restarted after granting it. |
| Picture frozen while the call app is in front | Make sure the Output window isn't minimized. Skillcam disables Chromium's occlusion throttling and App Nap; if it still freezes, report it with the Control window's numbers. |
| No "OBS Virtual Camera" in the call app | The extension isn't approved yet (step 4.2), or the call app was open before the camera started: quit it fully (⌘Q) and reopen. |
| Picture looks mirrored to the other person | It shouldn't be. Check that the OBS source has no flip transform. FaceTime's self-view is mirrored only on your side. |
| Laggy / low fps | Watch the Control window: render fps, per-stage ms and the quality level. Skillcam steps quality down by itself under load. OBS at 1280×720 / 30 fps keeps capture cheap. |
