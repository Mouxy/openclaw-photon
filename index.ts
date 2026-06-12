import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { PhotonConfigSchema } from "./src/config.js";
import { photonPlugin } from "./src/channel.js";
import { setPhotonRuntime } from "./src/runtime.js";

const plugin = {
  id: "photon",
  name: "Photon",
  description: "Photon Spectrum channel plugin for OpenClaw",
  configSchema: PhotonConfigSchema,
  register(api: OpenClawPluginApi) {
    setPhotonRuntime(api.runtime);
    api.registerChannel({ plugin: photonPlugin as any });
  },
};

export default plugin;
