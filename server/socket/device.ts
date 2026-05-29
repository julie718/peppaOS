import { Socket, Server } from "socket.io";
import { deviceRegistry } from "../devices";
import { registerUserSocket, unregisterUserSocket } from "../memory";

export function registerDeviceHandlers(socket: Socket, getUserId: (s: Socket) => string, io: Server) {
  socket.on("device:register", (data: {
    name?: string;
    type?: string;
    capabilities?: Record<string, boolean>;
    osInfo?: string;
  }) => {
    const uid = getUserId(socket);
    deviceRegistry.register(uid, socket.id, {
      name: data.name,
      type: data.type as any,
      capabilities: data.capabilities as any,
      osInfo: data.osInfo,
      ipAddress: socket.handshake.address,
    });
    registerUserSocket(uid, socket.id);
  });

  socket.on("disconnect", () => {
    const uid = getUserId(socket);
    deviceRegistry.disconnect(socket.id);
    unregisterUserSocket(socket.id);
  });
}
