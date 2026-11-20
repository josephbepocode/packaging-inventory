/** Camera scanning: native BarcodeDetector when the browser has it, otherwise ZXing (loaded on demand). */

type Detector = { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> };

export const hasCamera = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

/** Starts the camera into video and calls onCode for every decode. Returns a stop function. */
export async function startCamera(video: HTMLVideoElement, onCode: (code: string) => void): Promise<() => void> {
  const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
  if (BD) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = stream;
    await video.play();
    const det = new BD({ formats: ['qr_code', 'code_128', 'data_matrix'] });
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try { for (const r of await det.detect(video)) onCode(r.rawValue); } catch { /* frame not ready */ }
      window.setTimeout(tick, 200);
    };
    tick();
    return () => { stopped = true; stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; };
  }
  const { BrowserMultiFormatReader } = await import('@zxing/browser');
  const reader = new BrowserMultiFormatReader();
  const controls = await reader.decodeFromVideoDevice(undefined, video, (res) => { if (res) onCode(res.getText()); });
  return () => controls.stop();
}
