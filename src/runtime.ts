let photonRuntime: any;

export function setPhotonRuntime(runtime: any): void {
  photonRuntime = runtime;
}

export function getPhotonRuntime(): any {
  if (!photonRuntime) {
    throw new Error("Photon runtime has not been registered");
  }
  return photonRuntime;
}
