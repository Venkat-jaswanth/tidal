export interface GpuReport {
  crossOriginIsolated: boolean;
  webgpu: boolean;
  vendor: string;
  architecture: string;
  description: string;
  maxComputeWorkgroupStorageSize: number;
}

async function report(): Promise<GpuReport> {
  const adapter = 'gpu' in navigator ? await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
  return {
    crossOriginIsolated: self.crossOriginIsolated,
    webgpu: adapter !== null,
    vendor: adapter?.info.vendor ?? '',
    architecture: adapter?.info.architecture ?? '',
    description: adapter?.info.description ?? '',
    maxComputeWorkgroupStorageSize: adapter?.limits.maxComputeWorkgroupStorageSize ?? 0,
  };
}

declare global {
  interface Window {
    tidalReport?: Promise<GpuReport>;
  }
}

window.tidalReport = report();
