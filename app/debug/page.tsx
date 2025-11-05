export default function DebugPage() {
  // If this compiles, the alias + file path are good
  return <pre>✅ alias ok: {typeof window !== "undefined" ? "client" : "server"}</pre>;
}
