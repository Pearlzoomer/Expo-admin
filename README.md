# Mentor Portal (admin website)

React + Vite site for mentors, plus Cloud Functions. The student app needs **no code changes**.

## How it connects to your app
The app saves a request on the student's own `users/{uid}` document (`mentorRequests` = mentor names).
`syncMentorRequests` turns each one into `mentorRequests/{uid}_{mentorId}` (status `pending`) which this site reads.
Mentors then accept / decline / reschedule / complete through the `respondToRequest` function, which also sends the emails.

## Setup (one time)
1. `npm install -g firebase-tools` then `firebase login`
2. **Upgrade the Firebase project to the Blaze plan** (Cloud Functions need it; the free usage allowance is usually enough).
3. Make sure each mentor has a profile in the `mentors` collection (your `seedFirestore()` creates them; ids like `sipho-dlamini`).
4. **Approve each mentor's email** (this is what lets them create their own account):
   Firestore > Start collection `mentorInvites` > Document ID = the mentor's email in lower case
   (e.g. `sipho@company.com`) > field `mentorId` (string) = their mentor doc id (e.g. `sipho-dlamini`).
   Mentors then use "Create an account" on the site, verify their email, and are linked automatically.
   (`functions/scripts/setMentorClaim.js` still works if you'd rather link someone by hand.)
5. Enable Email/Password sign-in in Authentication (your app already does).
6. `cp functions/.env.example functions/.env` and fill in SMTP details (Gmail: use an App Password).
   Optional: fill the three GOOGLE_* values to get automatic Meet links. Without them, mentors paste a Meet link.
7. Deploy backend + rules: `firebase deploy --only functions,firestore:rules`
8. Run the site: `cp .env.example .env && npm install && npm run dev`  (host it with `npm run build && firebase deploy --only hosting`)

## Test checklist
- Student sends a request in the app -> a `mentorRequests` doc appears -> it shows under Pending for that mentor.
- Accept with a time + Meet link -> status Scheduled, both emails arrive.
- Decline needs a reason -> student gets the email. Withdraw in the app -> request moves to History.
- A mentor cannot see another mentor's requests.
- An email NOT in `mentorInvites` can sign up but gets "Access not available" and sees no student data.

## Notes
- Replying to the session email reaches the other person (reply-to is set), so they can email each other directly.
- Automatic Meet links use one Google account's OAuth refresh token (Calendar API, scope `calendar.events`).
