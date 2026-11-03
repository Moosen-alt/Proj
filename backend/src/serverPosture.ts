// IS THIS SERVER SOMEONE'S OWN PC, OR A SHARED ONE? (#439, epic #429)
//
// A few dashboard controls read a path on the SERVER'S disk: MBOX "Import Path", the email-watch
// path, the past-project folder scan, and "Launch record session" (which opens a terminal window
// on the server). On the operator's own machine "the server" and "my computer" are the same box,
// so those controls are a convenience. On a shared server a teammate who pastes
// C:\Users\me\mail.mbox gets a confusing error, or reads a file on the server they never meant
// to. The dashboard hides or relabels those controls when this answers true; the routes
// themselves are unchanged (their own confinement, #276/#282, still holds either way).
//
//   - SERVER_IS_SHARED=1/true  → shared, whatever else is set.
//   - SERVER_IS_SHARED=0/false → not shared, whatever else is set (an operator's own box that
//                                happens to listen on the LAN with sign-in on).
//   - unset                    → detected: sign-in on (AUTH_ENABLED=true, read exactly as auth.ts
//                                reads it) AND a non-loopback SERVER_HOST. That is the hosted shape
//                                (Docker, Fly, a VM). A server behind a tunnel on 127.0.0.1 is not
//                                detected; set SERVER_IS_SHARED=1 there.
//
// Pure (reads only the env it is handed), pinned by backend/test/serverPosture.test.ts.

import { DEFAULT_LISTEN_HOST, isLoopbackListenHost } from "./listenHost";

export function serverIsShared(env: Record<string, string | undefined>): boolean {
  const explicit = String(env.SERVER_IS_SHARED ?? "").trim().toLowerCase();
  if (explicit === "1" || explicit === "true") return true;
  if (explicit === "0" || explicit === "false") return false;
  const authOn = String(env.AUTH_ENABLED || "").toLowerCase() === "true";
  const host = String(env.SERVER_HOST ?? "").trim() || DEFAULT_LISTEN_HOST;
  return authOn && !isLoopbackListenHost(host);
}
