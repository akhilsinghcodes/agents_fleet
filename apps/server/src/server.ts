import http from "node:http";
import { createApp } from "./app";

const { app, hub } = createApp();

const server = http.createServer(app);
hub.attach(server);

const port = Number(process.env.PORT ?? 3001);

server.listen(port, () => {
  console.log(`Agents Fleet server listening on http://localhost:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
