# SkyUp CRM – get the installable APK

One universal APK (`SkyUpCRM-v1.1.0.apk`) that installs on any Android 7.0+ phone (32-bit and 64-bit).

## Option A – Windows PC (5 min after first setup)
1. Put `google-services.json` (Firebase console → Project settings → Android app) in `android\app\`.
2. Double-click **`build-apk.bat`** (uses SDK at `D:\Android\Sdk`, or whatever `ANDROID_HOME` says).
3. The folder with `SkyUpCRM-v1.1.0.apk` opens automatically. Send it on WhatsApp / Drive.

## Option B – no Android Studio needed (GitHub, free)
1. Push this folder to a GitHub repo.
2. Repo → Settings → Secrets → Actions → add `GOOGLE_SERVICES_JSON` (paste the file contents).
   Optional: `RELEASE_KEYSTORE_BASE64`, `RELEASE_STORE_PASSWORD`, `RELEASE_KEY_ALIAS`, `RELEASE_KEY_PASSWORD`.
3. Actions tab → **Build Android APK** → Run workflow. ~10 min later download it from *Artifacts*.
   (Push a tag `v1.1.0` and it is also published as a Release with a direct download link.)

## Installing on a phone
- Open the APK → allow "Install unknown apps" for WhatsApp/Chrome/Files when asked → Install.
- If an older SkyUp build is installed and Android says **"App not installed / conflicts with existing package"**, uninstall the old one first (it was signed with a different key). Keep using the same key from now on and updates install over the top.
- First launch: allow Phone, Call log, Contacts, Notifications and Files/Audio permissions, and turn on **auto call recording in the phone's own dialer** – the app picks up and auto-uploads those recordings.

## Signing (for real release)
Without a keystore the APK is signed with the bundled debug key – fine for sharing to your team.
To use your own key, uncomment the `MYAPP_RELEASE_*` lines in `android/gradle.properties`
and put the `.keystore` in `android/app/`. **Never lose this key** – a different key means everyone has to uninstall/reinstall.
