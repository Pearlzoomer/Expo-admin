const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");
const { randomUUID } = require("crypto");

initializeApp();
const db = getFirestore();
const TZ = "Africa/Johannesburg";

// ---------------------------------------------------------------------------
// 1) The app saves a request on the student's own user doc (users/{uid}.mentorRequests,
//    a list of mentor NAMES). This turns each one into a mentorRequests/{uid}_{mentorId}
//    document the mentor portal can read. The student app needs no changes.
// ---------------------------------------------------------------------------
exports.syncMentorRequests = onDocumentWritten("users/{uid}", async (event) => {
  const uid = event.params.uid;
  const before = event.data.before.exists ? event.data.before.data() : {};
  const after = event.data.after.exists ? event.data.after.data() : {};
  const was = before.mentorRequests || [];
  const now = after.mentorRequests || [];
  const added = now.filter((n) => !was.includes(n));
  const removed = was.filter((n) => !now.includes(n));

  for (const name of [...added, ...removed]) {
    const found = await db.collection("mentors").where("name", "==", name).limit(1).get();
    if (found.empty) continue;
    const mentorId = found.docs[0].id;
    const ref = db.collection("mentorRequests").doc(`${uid}_${mentorId}`);

    if (added.includes(name)) {
      const match = after.quizResult?.topMatch;
      await ref.set({
        studentId: uid,
        studentName: after.fullName || "Student",
        course: after.course || "",
        year: after.year || "",
        institution: after.institution || "",
        careerMatch: (match && (match.title || match.id)) || null,
        mentorId,
        mentorName: name,
        status: "pending",
        requestedAt: after.mentorRequestTimes?.[name] || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      const snap = await ref.get();
      if (snap.exists && snap.data().status === "pending") {
        await ref.update({ status: "withdrawn", updatedAt: FieldValue.serverTimestamp() });
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 2) Mentor actions from the portal: accept | reschedule | decline | cancel | complete
// ---------------------------------------------------------------------------
exports.respondToRequest = onCall(async (req) => {
  const mentorId = req.auth?.token?.mentorId;
  if (!mentorId) throw new HttpsError("permission-denied", "This account is not a mentor.");

  const { requestId, action, startsAt, durationMin, meetLink, reason } = req.data || {};
  const ref = db.collection("mentorRequests").doc(String(requestId || ""));
  const snap = await ref.get();
  if (!snap.exists || snap.data().mentorId !== mentorId) throw new HttpsError("not-found", "Request not found.");
  const r = snap.data();

  const student = (await db.collection("users").doc(r.studentId).get()).data() || {};
  const mentorUser = await getAuth().getUser(req.auth.uid);
  const people = { studentEmail: student.email, mentorEmail: mentorUser.email, studentName: r.studentName, mentorName: r.mentorName };
  const stamp = { updatedAt: FieldValue.serverTimestamp() };
  let emailSent = true;

  if (action === "accept" || action === "reschedule") {
    if (action === "accept" && r.status !== "pending") throw new HttpsError("failed-precondition", "Already handled.");
    if (action === "reschedule" && r.status !== "scheduled") throw new HttpsError("failed-precondition", "Not scheduled.");
    const start = new Date(startsAt);
    if (isNaN(start) || start < new Date()) throw new HttpsError("invalid-argument", "Pick a time in the future.");
    const mins = Math.min(Math.max(Number(durationMin) || 45, 15), 180);
    const end = new Date(start.getTime() + mins * 60000);

    let link = (meetLink || "").trim();
    if (!link) {
      link = await createMeet({ title: `Mentorship: ${r.mentorName} & ${r.studentName}`, start, end, emails: [student.email, mentorUser.email] });
    }
    if (!link) throw new HttpsError("failed-precondition", "Automatic Meet links are not set up. Paste a Google Meet link instead.");

    await ref.update({
      status: "scheduled", startsAt: Timestamp.fromDate(start), durationMin: mins, meetLink: link,
      declineReason: FieldValue.delete(), ...stamp,
    });
    const when = start.toLocaleString("en-ZA", { dateStyle: "full", timeStyle: "short", timeZone: TZ });
    emailSent = await mailBoth(people, `Mentorship session ${action === "accept" ? "confirmed" : "rescheduled"}`,
      (who) => `Hi ${who},\n\nThe mentorship session between ${r.mentorName} and ${r.studentName} is ${action === "accept" ? "confirmed" : "moved"}.\n\nWhen: ${when} (South Africa time)\nLength: ${mins} minutes\nGoogle Meet: ${link}\n\nYou can reply to this email to reach each other.\n\nTech Career Explorer`);
  } else if (action === "decline") {
    if (!String(reason || "").trim()) throw new HttpsError("invalid-argument", "A reason is required.");
    if (r.status !== "pending") throw new HttpsError("failed-precondition", "Already handled.");
    await ref.update({ status: "declined", declineReason: String(reason).trim(), ...stamp });
    emailSent = await mailStudent(people, "Update on your mentorship request",
      `Hi ${r.studentName},\n\n${r.mentorName} can't take your request right now.\n\nReason: ${String(reason).trim()}\n\nYou can request another mentor in the app.\n\nTech Career Explorer`);
  } else if (action === "cancel") {
    if (r.status !== "scheduled") throw new HttpsError("failed-precondition", "Not scheduled.");
    await ref.update({ status: "cancelled", declineReason: String(reason || "").trim() || FieldValue.delete(), ...stamp });
    emailSent = await mailStudent(people, "Your mentorship session was cancelled",
      `Hi ${r.studentName},\n\n${r.mentorName} had to cancel your session.${reason ? `\n\nNote: ${String(reason).trim()}` : ""}\n\nYou can request a new session in the app.\n\nTech Career Explorer`);
  } else if (action === "complete") {
    if (r.status !== "scheduled") throw new HttpsError("failed-precondition", "Not scheduled.");
    await ref.update({ status: "completed", ...stamp });
  } else {
    throw new HttpsError("invalid-argument", "Unknown action.");
  }
  return { ok: true, emailSent };
});

// ---------------------------------------------------------------------------
// 3) Self sign-up: a mentor who created an account (and verified their email) is linked
//    to their mentor profile ONLY if the admin approved that email in `mentorInvites`.
//    mentorInvites/{email in lower case} = { mentorId: "sipho-dlamini" }
// ---------------------------------------------------------------------------
exports.claimMentorAccess = onCall(async (req) => {
  try {
    if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
    if (req.auth.token.email_verified !== true) throw new HttpsError("failed-precondition", "Verify your email first.");
    const email = String(req.auth.token.email || "").toLowerCase();
    const invite = await db.collection("mentorInvites").doc(email).get();
    if (!invite.exists) {
      throw new HttpsError("permission-denied", `${email} has not been approved as a mentor. Ask the program admin to add you.`);
    }
    const mentorId = invite.data().mentorId;
    const profile = await db.collection("mentors").doc(String(mentorId)).get();
    if (!profile.exists) throw new HttpsError("not-found", `No mentors/${mentorId} profile found. Check the mentorId in mentorInvites.`);
    await getAuth().setCustomUserClaims(req.auth.uid, { mentorId });
    return { mentorId };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error("claimMentorAccess crashed:", e);
    throw new HttpsError("internal", `Server error: ${e.message}`);
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function createMeet({ title, start, end, emails }) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return null;
  try {
    const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
    const res = await google.calendar({ version: "v3", auth }).events.insert({
      calendarId: "primary",
      conferenceDataVersion: 1,
      sendUpdates: "none", // our own emails go out instead
      requestBody: {
        summary: title,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        attendees: emails.filter(Boolean).map((email) => ({ email })),
        conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
      },
    });
    return res.data.hangoutLink || null;
  } catch (e) {
    console.error("Meet creation failed", e.message);
    return null;
  }
}

function transport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT) || 465, secure: (Number(SMTP_PORT) || 465) === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
}
async function send(to, replyTo, subject, text) {
  const t = transport();
  if (!t || !to) return false;
  try {
    await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, replyTo, subject, text });
    return true;
  } catch (e) {
    console.error("Email failed", e.message);
    return false;
  }
}
const mailStudent = (p, subject, text) => send(p.studentEmail, p.mentorEmail, subject, text);
async function mailBoth(p, subject, body) {
  const a = await send(p.studentEmail, p.mentorEmail, subject, body(p.studentName));
  const b = await send(p.mentorEmail, p.studentEmail, subject, body(p.mentorName));
  return a && b;
}
