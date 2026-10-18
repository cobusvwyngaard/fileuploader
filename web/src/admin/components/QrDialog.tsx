import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';

const QR_OPTIONS = { errorCorrectionLevel: 'M' as const, margin: 2 };

function download(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const safeName = (title: string) => title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'upload';

/** QR code for exactly the session's share URL, downloadable as PNG and SVG. */
export function QrDialog({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [png, setPng] = useState<string | null>(null);

  useEffect(() => {
    ref.current?.showModal();
    QRCode.toDataURL(url, { ...QR_OPTIONS, width: 1024 }).then(setPng, () => setPng(null));
  }, [url]);

  const downloadSvg = async () => {
    const svg = await QRCode.toString(url, { ...QR_OPTIONS, type: 'svg', width: 1024 });
    const href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    download(href, `${safeName(title)}-qr.svg`);
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="qr-title">
      <div className="dialog-body">
        <h2 id="qr-title">QR code – {title}</h2>
        {png ? <img className="qr-preview" src={png} alt={`QR code linking to the upload page for ${title}`} /> : <p>Generating…</p>}
        <p className="share-link">{url}</p>
        <p className="muted small">Anyone with this link or QR code can submit files while the session is open.</p>
      </div>
      <div className="dialog-footer">
        <button type="button" className="btn" disabled={!png} onClick={() => png && download(png, `${safeName(title)}-qr.png`)}>
          Download PNG
        </button>
        <button type="button" className="btn" onClick={downloadSvg}>
          Download SVG
        </button>
        <button type="button" className="btn primary" onClick={() => ref.current?.close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}
