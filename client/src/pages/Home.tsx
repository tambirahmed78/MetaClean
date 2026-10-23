import { zipSync } from "fflate";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  FileImage,
  Fingerprint,
  HardDrive,
  ImagePlus,
  LockKeyhole,
  Play,
  Plus,
  ScanLine,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildNames,
  cleanImage,
  Finding,
  FilenameMode,
  formatBytes,
  inspectImage,
  isSupportedImage,
  verifyDecodable,
} from "@/lib/image-cleaner";

type QueueItem = {
  id: string;
  file: File;
  previewUrl: string;
  findings: Finding[];
  state: "scanning" | "ready" | "cleaning" | "done" | "error";
  error?: string;
  output?: Blob;
};

const categories = [
  { icon: "EXIF", title: "Camera & device details", note: "Camera model, device, software, and timestamps." },
  { icon: "GPS", title: "Location data", note: "Coordinates and location markers that can reveal where a photo was taken." },
  { icon: "XMP", title: "Editing history", note: "Fields added by photo editors and image workflows." },
  { icon: "IPTC", title: "Captions & copyright", note: "Embedded creator, caption, and rights information." },
  { icon: "C2PA", title: "Content Credentials", note: "The “made with AI” label added by ChatGPT, Adobe Firefly and others, including which tool made the image." },
  { icon: "AI", title: "Prompts & settings", note: "Common prompt, model, or generation-setting text markers." },
  { icon: "PNG", title: "Hidden PNG text", note: "Text chunks that may contain comments or app names." },
  { icon: "ICC", title: "Color profile", note: "An embedded color profile used to render the image consistently." },
];

const faqs = [
  ["Does my image get uploaded?", "No. MetaClean reads and re-encodes your selected files in this browser tab. There is no image upload endpoint in this app. Your files stay on your device."],
  ["Which formats are supported?", "JPEG, PNG, and WebP are supported for cleaning. Other formats—including HEIC, GIF, and animated images—are not accepted in this version. A current browser with createImageBitmap and canvas export is required."],
  ["Will the picture look exactly the same?", "The output is decoded and re-encoded by your browser. JPEG and WebP can have small compression differences; PNG remains lossless for pixel data. Browser color management can preserve the rendered appearance, but the original ICC profile block is not guaranteed to be copied verbatim."],
  ["Does it remove every AI watermark?", "No. It removes common embedded file metadata and text markers by exporting a fresh image. It cannot remove invisible watermarks encoded into the pixels (such as SynthID), and its marker scan is a practical indicator rather than a forensic guarantee."],
  ["What does “Make image unique” do?", "It changes the red value of one pixel by one step before export. That is a tiny pixel-level change, but normal image re-encoding may also affect the output. Leave it off if you do not need this."],
  ["Are animations or original profiles preserved?", "No. The cleaner currently supports still JPEG, PNG, and WebP. It exports a still image and does not promise to preserve the source ICC profile as a metadata block; with color retention enabled, the browser applies its normal color conversion while decoding."],
];

function fileId(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`;
}

function friendlyType(file: File) {
  const extension = file.name.split(".").pop()?.toUpperCase();
  return extension && extension.length <= 5 ? extension : "IMAGE";
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [keepColors, setKeepColors] = useState(true);
  const [makeUnique, setMakeUnique] = useState(false);
  const [filenameMode, setFilenameMode] = useState<FilenameMode>("suffix");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [batchRunning, setBatchRunning] = useState(false);
  const queueRef = useRef<QueueItem[]>([]);

  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => () => queueRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl)), []);

  const readyCount = queue.filter((item) => item.state === "ready").length;
  const doneItems = queue.filter((item) => item.state === "done" && item.output);
  const cleanableCount = readyCount + queue.filter((item) => item.state === "error").length;
  const filteredCategories = useMemo(() => categories.filter((item) => `${item.title} ${item.note} ${item.icon}`.toLowerCase().includes(search.toLowerCase())), [search]);

  const addFiles = async (list: FileList | File[]) => {
    const files = Array.from(list);
    const accepted: File[] = [];
    const messages: string[] = [];
    files.forEach((file) => {
      if (!isSupportedImage(file)) messages.push(`${file.name}: use a JPEG, PNG, or WebP image.`);
      else if (file.size > 50 * 1024 * 1024) messages.push(`${file.name}: files must be under 50 MB.`);
      else if (queue.some((item) => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) return;
      else accepted.push(file);
    });
    if (messages.length) setNotice(messages.slice(0, 2).join(" ") + (messages.length > 2 ? ` And ${messages.length - 2} more.` : ""));
    else if (accepted.length) setNotice("");
    if (!accepted.length) return;
    const newItems: QueueItem[] = accepted.map((file) => ({ id: fileId(file), file, previewUrl: URL.createObjectURL(file), findings: [], state: "scanning" }));
    setQueue((current) => [...current, ...newItems]);
    await Promise.all(newItems.map(async (item) => {
      try {
        await verifyDecodable(item.file);
        const findings = await inspectImage(item.file);
        setQueue((current) => current.map((row) => row.id === item.id ? { ...row, findings, state: "ready" } : row));
      } catch (error) {
        setQueue((current) => current.map((row) => row.id === item.id ? { ...row, state: "error", error: error instanceof Error ? error.message : "This image could not be read." } : row));
      }
    }));
  };

  const removeItem = (id: string) => {
    const item = queue.find((row) => row.id === id);
    if (item) URL.revokeObjectURL(item.previewUrl);
    setQueue((current) => current.filter((row) => row.id !== id));
    if (expanded === id) setExpanded(null);
  };

  const processItem = async (item: QueueItem) => {
    setQueue((current) => current.map((row) => row.id === item.id ? { ...row, state: "cleaning", error: undefined } : row));
    try {
      const output = await cleanImage(item.file, { keepColors, makeUnique });
      setQueue((current) => current.map((row) => row.id === item.id ? { ...row, state: "done", output } : row));
    } catch (error) {
      setQueue((current) => current.map((row) => row.id === item.id ? { ...row, state: "error", error: error instanceof Error ? error.message : "Cleaning failed." } : row));
    }
  };

  const cleanAll = async () => {
    if (batchRunning) return;
    setBatchRunning(true);
    const pending = queue.filter((item) => item.state === "ready");
    for (const item of pending) await processItem(item);
    setBatchRunning(false);
  };

  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const downloadOne = (item: QueueItem) => {
    if (!item.output) return;
    const done = queue.filter((row) => row.state === "done" && row.output);
    const names = buildNames(done.map((row) => row.file), filenameMode);
    const index = done.findIndex((row) => row.id === item.id);
    downloadBlob(item.output, names[index] ?? `${item.file.name}-clean`);
  };

  const downloadAll = async () => {
    if (!doneItems.length) return;
    const names = buildNames(doneItems.map((item) => item.file), filenameMode);
    const entries: Record<string, Uint8Array> = {};
    for (let index = 0; index < doneItems.length; index += 1) {
      entries[names[index]] = new Uint8Array(await doneItems[index].output!.arrayBuffer());
    }
    const zip = zipSync(entries, { level: 0 });
    downloadBlob(new Blob([zip], { type: "application/zip" }), "metaclean-images.zip");
  };

  const clearQueue = () => {
    queue.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    setQueue([]);
    setExpanded(null);
    setNotice("");
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="app-shell" id="top">
      <header className="topbar wrap">
        <a className="brand nav-brand" href="#top" aria-label="MetaClean home">
          <img className="brand-mark brand-logo" src="/MetaCleanLogo.png" alt="" aria-hidden="true" />
          <span className="nav-wordmark">Meta<span className="brand-strong">Clean</span></span>
        </a>
        <nav className="nav-links" aria-label="Page navigation">
          <a className="nav-link-active" href="#top" aria-current="page">Home</a><a href="#how">How it works</a><a href="#tutorial">Tutorial</a><a href="#metadata">What we remove</a><a href="#faq">FAQ</a>
        </nav>
        <a className="nav-cta" href="#top">Start cleaning <ArrowRight size={15} /></a>
      </header>

      <main>
        <section className="hero wrap">
          <div className="hero-copy">
            <p className="eyebrow"><span className="eyebrow-dot" /> PRIVATE BY DESIGN <span className="eyebrow-line" /> 01 / IMAGE CLEANER</p>
            <h1>Remove AI Image Metadata.<br /><span>Keep the Picture.</span></h1>
            <p className="hero-lede">Remove hidden AI metadata from images before sharing them online. Check image metadata and remove embedded AI-related information, prompts, and other supported metadata directly in your browser, without uploading your files.</p>
          </div>
          <div className="hero-aside">
            <div className="aside-rule" />
            <p><ShieldCheck size={16} /> YOUR FILES STAY HERE</p>
            <span>No upload. No account.<br />No server processing.</span>
          </div>
        </section>

        <section className="workbench wrap" aria-label="Image metadata remover">
          <div className={`dropzone ${dragging ? "dropzone-active" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void addFiles(event.dataTransfer.files); }}>
            <input ref={inputRef} className="file-input" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" multiple onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.target.value = ""; }} aria-label="Choose JPEG, PNG, or WebP images" />
            <div className="drop-icon"><Upload size={21} strokeWidth={1.8} /></div>
            <p className="drop-title">Drop images to begin</p>
            <p className="drop-subtitle">or choose files from this device</p>
            <button className="button button-primary" onClick={() => inputRef.current?.click()}><ImagePlus size={16} /> Choose images</button>
            <p className="format-note">JPEG <b>·</b> PNG <b>·</b> WebP <span>— up to 50 MB each</span></p>
            <div className="drop-corner corner-a" /><div className="drop-corner corner-b" />
          </div>

          <div className="settings-row">
            <label className="setting-toggle">
              <input type="checkbox" checked={keepColors} onChange={(event) => setKeepColors(event.target.checked)} />
              <span className="custom-check"><Check size={12} /></span><span><strong>Keep color appearance</strong><small>Browser color conversion</small></span>
            </label>
            <label className="setting-toggle">
              <input type="checkbox" checked={makeUnique} onChange={(event) => setMakeUnique(event.target.checked)} />
              <span className="custom-check"><Check size={12} /></span><span><strong>Make image unique</strong><small>Changes one pixel by 1 step</small></span>
            </label>
            <label className="name-setting"><span>Save names</span><select value={filenameMode} onChange={(event) => setFilenameMode(event.target.value as FilenameMode)} aria-label="Cleaned filename style"><option value="suffix">photo-clean.jpg</option><option value="prefix">clean-photo.jpg</option><option value="numbered">image-001.jpg</option><option value="original">Same as original</option></select><ChevronDown className="select-chevron" size={13} /></label>
          </div>
          <p className="icc-note"><span className="mini-lock"><LockKeyhole size={11} /></span> Color is interpreted in your browser. The original ICC profile itself may not be retained in the exported file.</p>

          {notice && <div className="notice" role="status"><CircleAlert size={16} /> <span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss message"><X size={15} /></button></div>}

          {queue.length > 0 && <div className="queue-panel" aria-live="polite">
            <div className="queue-heading">
              <div><div className="section-kicker"><span className="number-tag">02</span> LOCAL WORKSPACE</div><h2>Your images <span className="count-chip">{queue.length}</span></h2></div>
              <div className="queue-actions"><button className="button button-quiet" onClick={() => inputRef.current?.click()}><Plus size={15} /> Add more</button><button className="button button-quiet danger-quiet" onClick={clearQueue}><Trash2 size={15} /> Clear</button></div>
            </div>
            <div className="queue-table-head"><span>IMAGE / FILE</span><span>DETECTED MARKERS</span><span>SIZE</span><span>STATUS</span><span /></div>
            <div className="queue-list">
              {queue.map((item) => {
                const foundCount = item.findings.filter((finding) => finding.found).length;
                const outputName = buildNames([item.file], filenameMode)[0];
                return <article className="queue-item" key={item.id}>
                  <div className="file-cell"><img src={item.previewUrl} alt="" /><div className="file-meta"><strong title={item.file.name}>{item.file.name}</strong><span><FileImage size={12} /> {friendlyType(item.file)} <b>·</b> {item.file.type || "image file"}</span></div></div>
                  <div className="marker-cell">{item.state === "scanning" ? <span className="muted-status"><span className="pulse-dot" /> Scanning…</span> : item.state === "error" ? <span className="error-inline">Read error</span> : foundCount ? <button className="finding-link" onClick={() => setExpanded(expanded === item.id ? null : item.id)}><span className="finding-dot" /> {foundCount} {foundCount === 1 ? "category" : "categories"} found <ChevronDown size={13} className={expanded === item.id ? "rotate" : ""} /></button> : <span className="muted-status">No common markers</span>}</div>
                  <div className="size-cell"><strong>{formatBytes(item.file.size)}</strong>{item.output && <small>→ {formatBytes(item.output.size)}</small>}</div>
                  <div className="status-cell">{item.state === "scanning" ? <span className="status-pill status-scanning">Scanning</span> : item.state === "cleaning" ? <span className="status-pill status-working"><span className="pulse-dot" /> Cleaning</span> : item.state === "done" ? <span className="status-pill status-done"><Check size={12} /> Clean</span> : item.state === "error" ? <span className="status-pill status-error">Issue</span> : <span className="status-pill status-ready">Ready</span>}</div>
                  <div className="item-actions">{item.state === "done" ? <button className="icon-button download-icon" onClick={() => downloadOne(item)} aria-label={`Download ${outputName}`} title={`Download ${outputName}`}><ArrowDownToLine size={16} /></button> : null}<button className="icon-button" onClick={() => removeItem(item.id)} aria-label={`Remove ${item.file.name}`} title="Remove"><X size={16} /></button></div>
                  {item.state === "error" && <p className="file-error">{item.error}</p>}
                  {expanded === item.id && item.state !== "scanning" && <div className="findings-detail"><div className="details-title"><ScanLine size={15} /> Marker scan <span>LOCAL ONLY · NO VALUES STORED</span></div>{item.findings.some((finding) => finding.found) ? item.findings.filter((finding) => finding.found).map((finding) => <div className="finding-row" key={finding.id}><span className="finding-check"><Check size={12} /></span><div><strong>{finding.title}</strong><p>{finding.description}</p></div></div>) : <p className="empty-findings">No common metadata markers detected. This is not a guarantee that every metadata format or hidden watermark has been found.</p>}{item.state === "done" && <div className="clean-result"><Check size={14} /> Exported as <strong>{outputName}</strong> <span>{formatBytes(item.output?.size ?? 0)}</span></div>}</div>}
                </article>;
              })}
            </div>
            <div className="queue-footer"><div className="queue-summary"><span className="summary-mark"><HardDrive size={15} /></span><span><strong>{queue.length} {queue.length === 1 ? "file" : "files"} in this tab</strong><small>Originals stay untouched on your device.</small></span></div><div className="queue-footer-actions">{doneItems.length > 0 && <button className="button button-secondary" onClick={() => void downloadAll()}><ArrowDownToLine size={15} /> Download all <span className="button-count">{doneItems.length}</span></button>}<button className="button button-primary" onClick={() => void cleanAll()} disabled={batchRunning || readyCount === 0}>{batchRunning ? <><span className="button-spinner" /> Cleaning…</> : <><Sparkles size={15} /> Clean {readyCount > 0 ? `${readyCount} ${readyCount === 1 ? "image" : "images"}` : "images"} <ArrowRight size={14} /></>}</button></div></div>
            <p className="batch-note">{cleanableCount > 0 ? "Each image is re-encoded locally. Source files are never modified." : "Cleaned files are ready to download. Nothing has been sent anywhere."}</p>
          </div>}
        </section>

        <section className="how-section wrap" id="how">
          <div className="section-head"><div><div className="section-kicker"><span className="number-tag">03</span> A SHORT, LOCAL PROCESS</div><h2>From private to<br /><em>share-ready.</em></h2></div><p>Three steps. No upload progress bar, because your files never leave the browser.</p></div>
          <div className="steps">
            <article className="step-card"><span className="step-index">01</span><div className="step-icon"><Upload size={20} /></div><h3>Choose your images</h3><p>Drop in JPEG, PNG, or WebP files. We read them in this tab and show common metadata markers we notice.</p></article>
            <article className="step-card"><span className="step-index">02</span><div className="step-icon"><ScanLine size={20} /></div><h3>Clean the file</h3><p>Your browser redraws each image into a fresh file, leaving common metadata chunks behind.</p></article>
            <article className="step-card"><span className="step-index">03</span><div className="step-icon"><ArrowDownToLine size={20} /></div><h3>Save the clean copy</h3><p>Download individually or as a ZIP. Your original files stay where they are.</p></article>
          </div>
        </section>

        <section className="tutorial-section wrap" id="tutorial">
          <div className="section-head tutorial-head"><div><div className="section-kicker"><span className="number-tag">04</span> TUTORIAL</div><h2>Learn it once.<br /><em>Clean with confidence.</em></h2></div><p>A step-by-step walkthrough for using MetaClean to remove AI image metadata will be added here.</p></div>
          <div className="tutorial-video-placeholder" role="img" aria-label="MetaClean tutorial video coming soon">
            <span className="tutorial-play"><Play size={22} fill="currentColor" /></span>
            <span className="tutorial-video-label">VIDEO TUTORIAL <strong>COMING SOON</strong></span>
            <span className="tutorial-video-title">How to remove AI image metadata with MetaClean</span>
          </div>
        </section>

        <section className="metadata-section" id="metadata"><div className="wrap metadata-wrap">
          <div className="metadata-intro"><div className="section-kicker"><span className="number-tag">05</span> WHAT HIDES IN AN IMAGE</div><h2>What we<br /><em>remove.</em></h2><p>Pictures can carry a quiet trail of device, location, and editing details. MetaClean looks for common embedded markers in the file.</p><div className="search-wrap"><Search size={16} /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search metadata types" aria-label="Search metadata types" /></div><p className="metadata-disclaimer"><Fingerprint size={15} /> Marker detection is practical, not a forensic guarantee.</p></div>
          <div className="category-list">{filteredCategories.length ? filteredCategories.map((category, index) => <article className="category-row" key={category.title}><span className="category-no">{String(index + 1).padStart(2, "0")}</span><span className="category-code">{category.icon}</span><div><h3>{category.title}</h3><p>{category.note}</p></div><span className="category-arrow">↗</span></article>) : <p className="no-results">No metadata type matches “{search}”.</p>}</div>
        </div></section>

        <section className="faq-section wrap" id="faq"><div className="faq-heading"><div className="section-kicker"><span className="number-tag">06</span> THE FINE PRINT, MADE CLEAR</div><h2>Good questions.<br /><em>Straight answers.</em></h2><p>Privacy tools should be honest about what they can—and cannot—do.</p></div><div className="faq-list">{faqs.map(([question, answer], index) => <details className="faq-item" key={question} open={index === 0}><summary><span className="faq-index">{String(index + 1).padStart(2, "0")}</span><strong>{question}</strong><ChevronDown size={17} /></summary><p>{answer}</p></details>)}</div></section>

        <section className="final-note wrap"><div className="final-icon"><ShieldCheck size={20} /></div><div><strong>Your pictures are yours.</strong><p>Metadata cleaning happens on this device. This tool does not upload your images.</p></div><a href="#top">Back to top <ArrowRight size={14} /></a></section>
      </main>

      <footer className="footer wrap">
        <a className="brand brand-footer" href="#top" aria-label="MetaClean home">
          <img className="brand-mark brand-logo" src="/MetaCleanLogo.png" alt="" aria-hidden="true" />
          <span className="footer-brand-copy"><small>IMAGE HYGIENE TOOL</small><strong>MetaClean</strong><span>A simple way to remove image metadata.</span></span>
        </a>
        <div className="footer-built">
          <span>Built by <strong>Tambir Ahmed</strong></span>
          <span className="footer-tool-credit">A tool by <a href="https://ollenta.com" target="_blank" rel="noopener noreferrer">Ollenta</a></span>
        </div>
        <a className="footer-limitations" href="#faq">Limitations &amp; privacy <ArrowRight size={13} /></a>
      </footer>
    </div>
  );
}
