# Connect Google Calendar to Aura (one time, about 10 minutes)

Do this on a computer, signed in with the Google account whose calendar you want Mira to see.

1. Open https://console.cloud.google.com and create a new project called **Aura**
   (project menu at the top > New project > Create). Make sure Aura is the selected project.
2. Turn on the Calendar API: search the top bar for **Google Calendar API**, open it, click **Enable**.
3. Set up the sign-in screen: search for **Google Auth Platform** (or "OAuth consent screen") > **Get started**.
   App name: Aura. Support email: yours. Audience: **External**. Contact email: yours. Agree, then Create.
4. Add yourself as a tester: Google Auth Platform > **Audience** > Test users > **Add users** > your Gmail address > Save.
   (The app stays in "Testing", which is fine for your own use.)
5. Create the key for the app: Google Auth Platform > **Clients** > **Create client**.
   - Application type: **Web application**, name: Aura iPhone
   - Authorized JavaScript origins: `https://hendrasurja.github.io`
   - Authorized redirect URIs: `https://hendrasurja.github.io/Aura/`  (exactly this: capital A, slash at the end)
   - Create, then copy the **Client ID** (it ends with `.apps.googleusercontent.com`). You don't need the client secret.
6. In Aura on your iPhone: Settings > Connections > paste the Client ID > **Connect Google Calendar**.
   Google shows "Google hasn't verified this app": tap **Continue** (it's your own app), allow calendar access,
   and you're back in Aura with "Your Google Calendar is connected!"

Good to know
- Mira sees your primary calendar for the next 7 days. New events always wait for your tap on "Add to calendar".
- Google's sign-in lasts an hour; after that Aura quietly signs in again when you ask something (a quick flash).
- To stop: Settings > Disconnect Google Calendar. You can also remove access at myaccount.google.com > Security > Third-party access.
