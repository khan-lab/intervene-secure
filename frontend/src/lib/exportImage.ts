/** Serialize an on-screen SVG element (with inline styles resolved) and offer it as a download, as SVG or rasterized PNG. */

function svgToStandaloneString(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  if (!clone.getAttribute("width")) clone.setAttribute("width", String(svg.clientWidth));
  if (!clone.getAttribute("height")) clone.setAttribute("height", String(svg.clientHeight));
  return new XMLSerializer().serializeToString(clone);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadSvg(svg: SVGSVGElement, filename: string): void {
  const str = svgToStandaloneString(svg);
  triggerDownload(new Blob([str], { type: "image/svg+xml" }), filename);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not rasterize the diagram to PNG."));
    img.src = src;
  });
}

export async function downloadPng(svg: SVGSVGElement, filename: string, scale = 2): Promise<void> {
  const width = Number(svg.getAttribute("width")) || svg.clientWidth;
  const height = Number(svg.getAttribute("height")) || svg.clientHeight;
  const str = svgToStandaloneString(svg);
  const svgBlob = new Blob([str], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context is unavailable in this browser.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed."))), "image/png");
    });
    triggerDownload(pngBlob, filename);
  } finally {
    URL.revokeObjectURL(url);
  }
}
