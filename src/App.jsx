import { useEffect, useMemo, useState } from "react";
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendEmailVerification, signInWithPopup, signOut,
} from "firebase/auth";
import {
  collection, doc, getDoc, onSnapshot, query, where, updateDoc,
  serverTimestamp, deleteField, Timestamp,
} from "firebase/firestore";
import { auth, db, googleProvider } from "./firebase";

const fmt = (ts) =>
  ts?.toDate ? ts.toDate().toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" }) : "—";
const TABS = {
  pending: ["pending"],
  scheduled: ["scheduled"],
  history: ["completed", "declined", "cancelled", "withdrawn"],
};
const TITLES = { accept: "Accept request", reschedule: "Reschedule session", decline: "Decline request", cancel: "Cancel session" };

export default function App() {
  const [user, setUser] = useState(undefined);
  const [mentor, setMentor] = useState(null); // { mentorId, mentorName } once approved

  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setMentor(null);
        setUser(u || null);
      }),
    []
  );

  if (user === undefined) return <div className="center">Loading…</div>;
  if (!user) return <Login />;
  if (!mentor) return <Gate user={user} onDone={setMentor} />;
  return <Dashboard mentor={mentor} />;
}

const authMessage = (code) =>
  ({
    "auth/email-already-in-use": "An account with this email already exists. Sign in instead.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/too-many-requests": "Too many attempts. Please wait a bit and try again.",
    "auth/account-exists-with-different-credential": "This email already has a password account. Sign in with your password instead.",
    "auth/popup-closed-by-user": "Google sign-in was closed before it finished.",
    "auth/popup-blocked": "Your browser blocked the Google pop-up. Allow pop-ups and try again.",
  }[code] || "Wrong email or password.");

function Login() {
  const [mode, setMode] = useState("signin"); // signin | signup
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const signup = mode === "signup";

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (signup && password !== confirm) return setErr("The two passwords don't match.");
    setBusy(true);
    try {
      if (signup) {
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await sendEmailVerification(cred.user);
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }
    } catch (e2) {
      setErr(authMessage(e2.code));
    }
    setBusy(false);
  };

  const google = async () => {
    setErr("");
    setBusy(true);
    try {
      await signInWithPopup(auth, googleProvider); // Google emails arrive already verified
    } catch (e2) {
      setErr(authMessage(e2.code));
    }
    setBusy(false);
  };

  return (
    <div className="center">
      <form className="card" style={{ width: "100%", maxWidth: 380 }} onSubmit={submit}>
        <div className="eyebrow" style={{ color: "var(--mid)" }}>Tech Career Explorer</div>
        <h1 style={{ color: "var(--deep)", marginBottom: 14 }}>{signup ? "Create mentor account" : "Mentor Portal"}</h1>
        <label>Email</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {signup && (
          <>
            <label>Confirm password</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            <p className="sub" style={{ marginTop: -4 }}>Use the email address the program has on file for you.</p>
          </>
        )}
        {err && <p className="err">{err}</p>}
        <button className="btn" style={{ width: "100%" }} disabled={busy}>
          {busy ? "Please wait…" : signup ? "Create account" : "Sign in"}
        </button>
        <div className="sub" style={{ textAlign: "center", margin: "12px 0" }}>or</div>
        <button type="button" className="btn ghost" style={{ width: "100%" }} disabled={busy} onClick={google}>
          Continue with Google
        </button>
        <p className="sub" style={{ textAlign: "center", marginTop: 14 }}>
          {signup ? "Already have an account? " : "New mentor? "}
          <a href="#" onClick={(e) => { e.preventDefault(); setErr(""); setMode(signup ? "signin" : "signup"); }}>
            {signup ? "Sign in" : "Create an account"}
          </a>
        </p>
      </form>
    </div>
  );
}

// A signed-in user needs a verified email AND must be on the approved list (mentorInvites).
function Gate({ user, onDone }) {
  const [state, setState] = useState(user.emailVerified ? "checking" : "verify");
  const [msg, setMsg] = useState("");

  const check = async () => {
    setState("checking"); setMsg("");
    try {
      await user.reload();
      await auth.currentUser.getIdToken(true); // so the rules see email_verified = true
      if (!auth.currentUser.emailVerified) { setState("verify"); setMsg("Your email isn't verified yet."); return; }
      const email = auth.currentUser.email.toLowerCase();
      const invite = await getDoc(doc(db, "mentorInvites", email));
      if (!invite.exists()) {
        setState("denied");
        setMsg(`${email} has not been approved as a mentor. Ask the program admin to add it.`);
        return;
      }
      const { mentorId } = invite.data();
      const m = await getDoc(doc(db, "mentors", String(mentorId)));
      onDone({ mentorId: String(mentorId), mentorName: m.exists() ? m.data().name : "Mentor" });
    } catch (e) {
      console.error("mentor check failed:", e);
      setState("denied");
      setMsg(`${e.code || "error"}: ${e.message || "Something went wrong."}`);
    }
  };

  useEffect(() => { if (user.emailVerified) check(); /* eslint-disable-next-line */ }, []);

  const resend = async () => {
    try { await sendEmailVerification(auth.currentUser); setMsg("Verification email sent again."); }
    catch { setMsg("Please wait a minute before asking for another email."); }
  };

  return (
    <div className="center">
      <div className="card" style={{ maxWidth: 400 }}>
        {state === "checking" && <div className="name">Checking your mentor access…</div>}
        {state === "verify" && (
          <>
            <div className="name">Verify your email</div>
            <p className="sub">We sent a link to {user.email}. Open it, then come back and continue.</p>
            {msg && <p className="note">{msg}</p>}
            <div className="btns">
              <button className="btn" onClick={check}>I've verified — continue</button>
              <button className="btn ghost" onClick={resend}>Resend email</button>
            </div>
          </>
        )}
        {state === "denied" && (
          <>
            <div className="name">Access not available</div>
            <p className="err">{msg}</p>
            <p className="sub">Only mentors approved by the program can use this portal.</p>
            <div className="btns"><button className="btn" onClick={check}>Try again</button></div>
          </>
        )}
        <div className="btns" style={{ marginTop: 10 }}>
          <button className="btn ghost" onClick={() => signOut(auth)}>Sign out</button>
        </div>
      </div>
    </div>
  );
}

// Opens Gmail with the message already written; the mentor just presses Send.
const gmail = (to, subject, body) =>
  `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to || "")}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

function emailFor(r) {
  if (r.status === "scheduled") {
    const when = r.startsAt?.toDate().toLocaleString("en-ZA", { dateStyle: "full", timeStyle: "short" });
    return {
      subject: `Mentorship session: ${r.studentName} & ${r.mentorName}`,
      body: `Hi ${r.studentName},\n\nYour mentorship session with ${r.mentorName} is confirmed.\n\nWhen: ${when} (South Africa time)\nLength: ${r.durationMin} minutes\nGoogle Meet: ${r.meetLink}\n\nIf you need to reschedule, just reply to this email.\n\nKind regards,\n${r.mentorName}`,
    };
  }
  return {
    subject: "Update on your mentorship request",
    body: `Hi ${r.studentName},\n\nThank you for your request. Unfortunately I can't take it right now.\n\nReason: ${r.declineReason || ""}\n\nYou can request another mentor in the app.\n\nKind regards,\n${r.mentorName}`,
  };
}

function Dashboard({ mentor }) {
  const [rows, setRows] = useState([]);
  const [tab, setTab] = useState("pending");
  const [modal, setModal] = useState(null); // { req, mode }
  const [toast, setToast] = useState("");

  useEffect(() => {
    const q = query(collection(db, "mentorRequests"), where("mentorId", "==", mentor.mentorId));
    return onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => (b.requestedAt?.seconds || 0) - (a.requestedAt?.seconds || 0));
        setRows(list);
      },
      (e) => setToast(`${e.code}: ${e.message}`)
    );
  }, [mentor.mentorId]);

  const counts = useMemo(
    () => Object.fromEntries(Object.entries(TABS).map(([k, v]) => [k, rows.filter((r) => v.includes(r.status)).length])),
    [rows]
  );
  const shown = rows.filter((r) => TABS[tab].includes(r.status));

  const complete = async (r) => {
    try {
      await updateDoc(doc(db, "mentorRequests", r.id), { status: "completed", updatedAt: serverTimestamp() });
    } catch (e) {
      setToast(`${e.code}: ${e.message}`);
    }
  };

  return (
    <div className="wrap">
      <div className="top">
        <div>
          <div className="eyebrow">Mentor Portal · {mentor.mentorName}</div>
          <h1>Mentorship requests</h1>
        </div>
        <button className="tab" onClick={() => signOut(auth)}>Sign out</button>
      </div>

      <div className="tabs">
        {Object.keys(TABS).map((k) => (
          <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
            {k[0].toUpperCase() + k.slice(1)} ({counts[k]})
          </button>
        ))}
      </div>
      {toast && <p className="err" style={{ color: "#fecaca" }}>{toast}</p>}

      <div className="stack">
        {shown.length === 0 && <div className="empty">Nothing here yet.</div>}
        {shown.map((r) => {
          const canEmail = r.status === "scheduled" || r.status === "declined";
          const em = canEmail ? emailFor(r) : null;
          return (
            <div className="card" key={r.id}>
              <div className="row">
                <div>
                  <div className="name">{r.studentName}</div>
                  <div className="sub">{[r.course, r.year && `Year ${r.year}`, r.institution].filter(Boolean).join(" · ")}</div>
                </div>
                <span className={`pill ${r.status}`}>{r.status}</span>
              </div>
              <div className="meta">
                <div>Requested: {fmt(r.requestedAt)}</div>
                {r.studentEmail && <div>Email: {r.studentEmail}</div>}
                {r.careerMatch && <div>Career match from quiz: {r.careerMatch}</div>}
                {r.status === "scheduled" && (
                  <>
                    <div>Session: <b>{fmt(r.startsAt)}</b> ({r.durationMin} min)</div>
                    <div>Meet: <a href={r.meetLink} target="_blank" rel="noreferrer">{r.meetLink}</a></div>
                  </>
                )}
                {r.declineReason && <div>Reason: {r.declineReason}</div>}
              </div>
              <div className="btns">
                {r.status === "pending" && (
                  <>
                    <button className="btn" onClick={() => setModal({ req: r, mode: "accept" })}>Accept</button>
                    <button className="btn ghost" onClick={() => setModal({ req: r, mode: "decline" })}>Decline</button>
                  </>
                )}
                {r.status === "scheduled" && (
                  <>
                    <button className="btn" onClick={() => complete(r)}>Mark completed</button>
                    <button className="btn ghost" onClick={() => setModal({ req: r, mode: "reschedule" })}>Reschedule</button>
                    <button className="btn ghost" onClick={() => setModal({ req: r, mode: "cancel" })}>Cancel</button>
                  </>
                )}
                {canEmail && (
                  <a className="btn" href={gmail(r.studentEmail, em.subject, em.body)} target="_blank" rel="noreferrer">
                    Email student (Gmail)
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {modal && <ActionModal {...modal} onClose={() => setModal(null)} onDone={() => setModal(null)} />}
    </div>
  );
}

function ActionModal({ req, mode, onClose, onDone }) {
  const needsTime = mode === "accept" || mode === "reschedule";
  const [when, setWhen] = useState("");
  const [duration, setDuration] = useState(45);
  const [link, setLink] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr("");
    if (needsTime && !when) return setErr("Pick a date and time.");
    if (needsTime && !/^https?:\/\//.test(link.trim())) return setErr("Paste the Google Meet link (use the Create Meet link button).");
    if (mode === "decline" && !reason.trim()) return setErr("Give the student a short reason.");
    setBusy(true);
    try {
      const base = { updatedAt: serverTimestamp() };
      let data;
      if (needsTime) {
        data = { ...base, status: "scheduled", startsAt: Timestamp.fromDate(new Date(when)), durationMin: Number(duration) || 45, meetLink: link.trim(), declineReason: deleteField() };
      } else if (mode === "decline") {
        data = { ...base, status: "declined", declineReason: reason.trim() };
      } else {
        data = { ...base, status: "cancelled", declineReason: reason.trim() || deleteField() };
      }
      await updateDoc(doc(db, "mentorRequests", req.id), data);
      onDone();
    } catch (e) {
      setErr(`${e.code || "error"}: ${e.message || "Something went wrong."}`);
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h1 style={{ fontSize: 20, color: "var(--deep)", marginBottom: 12 }}>{TITLES[mode]}</h1>
        <div className="sub" style={{ marginBottom: 12 }}>{req.studentName}</div>
        {needsTime && (
          <>
            <label>Date and time</label>
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            <label>Length (minutes)</label>
            <input type="number" min="15" step="15" value={duration} onChange={(e) => setDuration(e.target.value)} />
            <label>Google Meet link</label>
            <input placeholder="https://meet.google.com/..." value={link} onChange={(e) => setLink(e.target.value)} />
            <a className="btn ghost" href="https://meet.new" target="_blank" rel="noreferrer" style={{ marginBottom: 12 }}>
              Create Meet link
            </a>
          </>
        )}
        {!needsTime && (
          <>
            <label>{mode === "decline" ? "Reason (included in the email to the student)" : "Note (optional)"}</label>
            <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </>
        )}
        {err && <p className="err">{err}</p>}
        <div className="btns" style={{ marginTop: 0 }}>
          <button className={`btn ${mode === "decline" || mode === "cancel" ? "danger" : ""}`} disabled={busy} onClick={submit}>
            {busy ? "Working…" : "Confirm"}
          </button>
          <button className="btn ghost" onClick={onClose}>Back</button>
        </div>
      </div>
    </div>
  );
}
