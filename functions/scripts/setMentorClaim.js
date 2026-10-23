// Links a mentor's login to their mentor profile in Firestore.
// Usage: GOOGLE_APPLICATION_CREDENTIALS=serviceAccount.json node scripts/setMentorClaim.js mentor@email.com sipho-dlamini
// (the second value is the document id in the `mentors` collection, e.g. "sipho-dlamini")
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

(async () => {
  const [email, mentorId] = process.argv.slice(2);
  if (!email || !mentorId) return console.log("Usage: node scripts/setMentorClaim.js <email> <mentorDocId>");
  initializeApp({ projectId: "techexplorerapp" });
  const m = await getFirestore().collection("mentors").doc(mentorId).get();
  if (!m.exists) return console.log(`No mentors/${mentorId} document found.`);
  const user = await getAuth().getUserByEmail(email);
  await getAuth().setCustomUserClaims(user.uid, { mentorId });
  console.log(`Linked ${email} -> ${m.data().name}. They must sign out and in again.`);
})().catch((e) => console.error(e.message));
