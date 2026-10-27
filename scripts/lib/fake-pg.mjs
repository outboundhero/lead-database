// A minimal fake Postgres server (protocol 3, no TLS, no password) for testing a
// route's database paths — failing, timing out, going silent — without a real
// database. Used by scripts/test-costing-feed.mts.
//
// Every query's SQL goes to answer(sql), which returns:
//   undefined                     → success with no rows (BEGIN / SET / COMMIT / ROLLBACK)
//   { rows: { cols, rows } }      → a result; cols are [name, type oid], values are text or null
//   { error: [sqlstate, message] } → an ERROR with that SQLSTATE
//   "hang"                        → never answer
//   "drop"                        → close the connection
// startupDelay(ms) holds back the answer to each new connection's startup
// (Infinity: never answer); drop() closes every open connection.
import net from "node:net";

export const TEXT = 25, JSONB = 3802;

const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const int16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const cstr = (s) => Buffer.from(`${s}\0`, "utf8");
const msg = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
};

export function startFakePg(answer) {
  const sockets = new Set();
  let startupDelay = 0;
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let buf = Buffer.alloc(0), started = false, tx = "I", parsed = "";

    const respond = (sql, extended) => {
      const a = answer(sql);
      if (a === "hang") return;
      if (a === "drop") { sock.destroy(); return; }
      if (a?.error) {
        if (tx === "T") tx = "E";
        sock.write(Buffer.concat([
          msg("E", Buffer.from("S"), cstr("ERROR"), Buffer.from("C"), cstr(a.error[0]), Buffer.from("M"), cstr(a.error[1]), Buffer.from([0])),
          msg("Z", Buffer.from(tx)),
        ]));
        return;
      }
      const verb = sql.trim().split(/\s+/)[0].toUpperCase();
      if (verb === "BEGIN") tx = "T";
      else if (verb === "COMMIT" || verb === "ROLLBACK") tx = "I";
      const out = extended ? [msg("1"), msg("2")] : []; // ParseComplete, BindComplete
      if (a?.rows) {
        out.push(msg("T", int16(a.rows.cols.length),
          ...a.rows.cols.flatMap(([name, oid]) => [cstr(name), int32(0), int16(0), int32(oid), int16(-1), int32(-1), int16(0)])));
        for (const r of a.rows.rows) {
          out.push(msg("D", int16(r.length), ...r.flatMap((v) => (v == null ? [int32(-1)] : [int32(Buffer.byteLength(v)), Buffer.from(v)]))));
        }
        out.push(msg("C", cstr(`SELECT ${a.rows.rows.length}`)));
      } else {
        if (extended) out.push(msg("n")); // NoData
        out.push(msg("C", cstr(verb)));
      }
      out.push(msg("Z", Buffer.from(tx)));
      sock.write(Buffer.concat(out));
    };

    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (!started) { // SSLRequest / StartupMessage: [length][code][...]
          if (buf.length < 8 || buf.length < buf.readInt32BE(0)) return;
          const len = buf.readInt32BE(0), code = buf.readInt32BE(4);
          buf = buf.subarray(len);
          if (code === 80877103) { sock.write("N"); continue; } // no TLS here
          started = true;
          const ready = () => { if (!sock.destroyed) sock.write(Buffer.concat([msg("R", int32(0)), msg("K", int32(1), int32(2)), msg("Z", Buffer.from("I"))])); };
          if (startupDelay === 0) ready();
          else if (startupDelay !== Infinity) setTimeout(ready, startupDelay);
          continue;
        }
        if (buf.length < 5 || buf.length < buf.readInt32BE(1) + 1) return;
        const type = String.fromCharCode(buf[0]), len = buf.readInt32BE(1);
        const body = buf.subarray(5, len + 1);
        buf = buf.subarray(len + 1);
        if (type === "X") { sock.end(); return; }
        if (type === "Q") respond(body.subarray(0, body.indexOf(0)).toString(), false);
        else if (type === "P") { const nameEnd = body.indexOf(0); parsed = body.subarray(nameEnd + 1, body.indexOf(0, nameEnd + 1)).toString(); }
        else if (type === "S") respond(parsed, true);
        // B (bind), D (describe), E (execute), H (flush) are answered together at S (sync)
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    port: server.address().port,
    connections: () => sockets.size, // client connections still open
    startupDelay: (ms) => { startupDelay = ms; },
    drop: () => { for (const s of sockets) s.destroy(); },
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  })));
}
