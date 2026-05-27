# Combined fix bundle — apply in order

This bundle contains **all 9 fixes** from the previous two rounds (perf bundle + Piece 1) merged into a single set. The `AttendanceWidget.js` and `App.js` files are the **Piece 1 versions** which include both the perf fixes and the call-detection additions. Don't apply earlier individual zips on top of this — just use this folder.

## What's in here

```
android/gradle.properties                                          ← perf
android/app/build.gradle                                           ← perf
android/app/proguard-rules.pro                                     ← perf (new file)
android/app/src/main/java/com/skyupcrm/MainApplication.kt          ← Piece 1 (modified)
android/app/src/main/java/com/skyupcrm/calldetect/CallStateModule.kt   ← Piece 1 (new)
android/app/src/main/java/com/skyupcrm/calldetect/CallStatePackage.kt  ← Piece 1 (new)
src/services/api.js                                                ← perf
src/services/backgroundSyncService.js                              ← perf
src/services/callStateService.js                                   ← Piece 1 (new)
src/components/AttendanceWidget.js                                 ← perf + Piece 1
src/screens/leads/LeadDetailScreen.js                              ← perf
App.js                                                             ← perf + Piece 1
```

## Step-by-step application — do these IN ORDER

### Step 1 — Back up your current code

Before anything: commit your current state to git, or zip your `mobile-app/` folder. If something breaks, you need a rollback.

```bash
cd path/to/mobile-app
git add -A && git commit -m "Pre-fix snapshot"
```

### Step 2 — Copy the files into your project

For each file in this bundle, replace the file at the same relative path in your project. The paths in this zip mirror the paths in your project root.

After copying:
- Spot-check `App.js` opens with the new imports (lines for `startCallStateListener` and `InteractionManager`)
- Spot-check `MainApplication.kt` has `import com.skyupcrm.calldetect.CallStatePackage`
- Confirm `android/app/src/main/java/com/skyupcrm/calldetect/` directory exists with TWO `.kt` files

### Step 3 — Clean and rebuild

```bash
cd android
./gradlew clean
cd ..

rm -rf node_modules/.cache
# Optional but useful after big changes — also reset Metro cache:
# npx react-native start --reset-cache  (then kill it once it's running)

npm run build:android
```

The release APK will be at `android/app/build/outputs/apk/release/`. With ABI splits enabled, you'll see TWO APKs:
- `app-arm64-v8a-release.apk` — for modern phones (most users)
- `app-armeabi-v7a-release.apk` — for older phones

For most modern phones (2018+), use the arm64 one.

### Step 4 — Install on a real Android device

Emulators won't help — you need a real phone with a SIM to test the call-detection piece.

```bash
adb install -r android/app/build/outputs/apk/release/app-arm64-v8a-release.apk
```

If install fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, uninstall first:

```bash
adb uninstall com.skyupcrm
adb install android/app/build/outputs/apk/release/app-arm64-v8a-release.apk
```

### Step 5 — First-launch sanity check

Before testing the actual fixes, confirm the app didn't break:

1. Launch the app
2. Log in
3. Navigate to Dashboard, Leads, Call Logs, Recordings, Profile (each tab once)
4. No crashes, no white screens

If the app crashes immediately on launch, it's almost certainly R8 stripping a class it shouldn't. Run logcat to see what's missing:

```bash
adb logcat -s AndroidRuntime:E *:S
```

Look for `ClassNotFoundException: com.something.X`. Add a keep rule to `android/app/proguard-rules.pro`:

```
-keep class com.something.** { *; }
```

Rebuild and retry. The included keep rules cover everything I could see in your `package.json`, but native modules added since may need their own.

## How to verify each fix actually works

### Fix 1 — APK is smaller (drop x86 ABIs + R8)

```bash
ls -lh android/app/build/outputs/apk/release/app-arm64-v8a-release.apk
```

Compare to your old APK. Expect the new one to be **30–50% smaller**. If they're roughly the same size, R8 didn't run — check that `enableProguardInReleaseBuilds = true` in `build.gradle` and rebuild.

### Fix 2 — Console logs stripped in production

```bash
adb logcat -s ReactNativeJS:V
```

Tap around the app. You should see **no** `[API →]` or `[API ✓]` lines. If you do, `IS_DEV` flag isn't false. Check `src/config/config.js` line 5.

### Fix 3 — Background sync delayed to 15s after login

```bash
adb logcat -s ReactNativeJS:V | grep -i sync
```

(Set `IS_DEV=true` temporarily in `src/config/config.js` for this test, since logs are stripped in prod.)

Log out, log in. The sync log line should appear ~15 seconds after login, not 4.

### Fix 4 — Call-state detection (Piece 1) — the most visible test

1. Open app, log in, go to Dashboard
2. Have someone call your test phone
3. Within ~1 second, AttendanceWidget status chip changes from green "Active" to blue "On Call"
4. Hang up — chip returns to "Active"

If chip never changes:
- Did you grant `READ_PHONE_STATE` when the app asked? Check Settings → Apps → SkyUp CRM → Permissions
- Are you on a real device, not an emulator?
- Run `adb logcat -s ReactNativeJS:V` during a call. Should see `CallStateChanged` events. If not, the native module didn't register — check that `MainApplication.kt` has `packages.add(CallStatePackage())` and `CallStatePackage.kt` exists in the right folder.

### Fix 5 — Idle skips during calls

To verify quickly without waiting 5 minutes for a real idle window:

1. Open `src/components/AttendanceWidget.js` — find `const IDLE_MS = 5 * 60 * 1000;`
2. Temporarily change to `const IDLE_MS = 30 * 1000;` (30 seconds)
3. Rebuild + install
4. Clock in
5. Call yourself, stay on call past 30 seconds
6. Without this fix: auto-marked idle, put into break mode
7. With this fix: stays "On Call", no auto-break
8. **REVERT IDLE_MS to `5 * 60 * 1000` before shipping**

### Fix 6 — Lead Detail opens instantly

Open Leads tab → tap any lead. Detail screen should appear immediately. The "Device Call History" section now shows a **"Load device call history" button** instead of an automatic spinner. Tap to load the 200-log scan only when needed.

### Fix 7 — AttendanceWidget single listener + focus-aware tick

Hard to verify visually. Trust the code change unless you see issues.

### Fix 8 — Health check deferred

```bash
adb logcat -s ReactNativeJS:V | grep -i health
```

(Again, with `IS_DEV=true` temporarily.) Cold-start app. `[Health]` log appears ~1–2 seconds after first paint.

### Fix 9 — Foreground throttle 5min → 10min

Switch app to background, immediately switch back. No new sync fires. Hard to verify without waiting; trust the code change.

## If something is broken after applying

**App crashes on launch with `ClassNotFoundException`**
R8 stripped a class that needed keeping. See Step 5 above.

**App launches but crashes when making a call**
Run `adb logcat -s AndroidRuntime:E ReactNativeJS:E *:S` during the call attempt. Likely cause: permission not granted; the module should no-op gracefully but a code path may be wrong. Send me the stack trace.

**Build fails with "duplicate class" or "unresolved reference"**
You probably have leftover files from a previous attempt. Clean fully:
```bash
cd android
./gradlew clean
rm -rf .gradle build
cd ..
rm -rf node_modules/.cache
npm run build:android
```

**Code change isn't running** (e.g., chip doesn't change on call)
Check the file actually got replaced. Open it in your editor — look for the `// PIECE 1` or `// PERF FIX` comment markers. If they're not there, the file wasn't replaced.

## After you've tested

Report back with one of three things:

1. **"All 9 fixes work"** → I'll write the instant-nav fix (#10 #11 #12)
2. **"X is broken"** → paste the relevant logcat output, I'll fix that fix
3. **"Most works but freezing still happens"** → run `adb logcat -s ReactNativeJS:V *:S | tee freeze.log` while reproducing the freeze, send me the last 30 lines. Then we'll know whether to write #10–#12 or something else.

Don't apply anything else from previous zips on top of this. This bundle is the union of everything to date.
