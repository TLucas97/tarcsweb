import { useEffect, useEffectEvent, useRef, useState, type DragEvent } from 'react';
import { ASK_UPLOAD_MAX, IMAGE_MIMES, ROUND_CANCELLED, acceptsFile, uploadProblem, type RichDetail, type Upload } from '../../server/protocol.ts';
import { onNotice, useStore, type RichItem } from './store.ts';
import { send } from './socket.ts';
import { readFiles } from './attach.ts';
import { FileChip } from './Composer.tsx';
import { ToolImage } from './LocalImage.tsx';
import { Pending } from './bits.tsx';

type Detail = Extract<RichDetail, { kind: 'upload' }>;
type Picked = { key: string; upload: Upload };

// Pictures under this go as they are; bigger ones are scaled down like composer attachments, to fit the server's cap.
const IMAGE_RAW_MAX = 5_000_000;
// All files ride in one socket frame, which the server caps at 40 MB.
const SEND_MAX = 36_000_000;
// Picked files survive a session switch until sent; oldest first past the cap.
const picked = new Map<string, Picked[]>();
const PICKED_MAX = 10;
// Asks answered from this page whose result has not come back yet, with the line to show meanwhile; capped like picked.
const sent = new Map<string, string>();
// With no result by then, the answer is taken as lost and Send/Cancel come back.
const SENT_WAIT_MS = 60_000;

const cancelled = (e: string) => e === ROUND_CANCELLED || /interrupt/i.test(e);
const sizeText = (b: number) => (b < 1024 ? `${b} B` : b < 1 << 20 ? `${Math.round(b / 1024)} KB` : `${(b / (1 << 20)).toFixed(1)} MB`);
const names = (fs: File[]) => fs.map((f) => f.name || 'file').join(', ');

const base64 = (f: File) =>
  new Promise<string>((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => no(r.error);
    r.readAsDataURL(f);
  });

// Pictures keep their bytes, since the agent works with the file itself; the rest read like composer attachments.
async function readAll(files: File[]): Promise<{ ok: Picked[]; skipped: string[] }> {
  const raw = files.filter((f) => IMAGE_MIMES.includes(f.type) && f.size <= IMAGE_RAW_MAX);
  const ok: Picked[] = [];
  const skipped: string[] = [];
  for (const f of raw) {
    try {
      ok.push({ key: crypto.randomUUID(), upload: { name: f.name || 'image', kind: 'image', mime: f.type, data: await base64(f) } });
    } catch {
      skipped.push(f.name || 'file');
    }
  }
  const rest = await readFiles(files.filter((f) => !raw.includes(f)));
  return { ok: [...ok, ...rest.ok.map((p) => ({ key: p.key, upload: p.upload }))], skipped: [...skipped, ...rest.skipped] };
}

function remember(id: string, files: Picked[]) {
  picked.delete(id);
  if (files.length) picked.set(id, files);
  if (picked.size > PICKED_MAX) picked.delete(picked.keys().next().value!);
}

function UploadDone({ item, d }: { item: RichItem; d: Detail }) {
  const r = item.result!;
  if (r.error) {
    return (
      <div className="say old aqd rnd-done" data-id={item.id}>
        <div className="rnd-t">{d.prompt}{d.prompt ? ' · ' : ''}{cancelled(r.error) ? <span className="pick-none">No files sent</span> : <span className="rnd-err">{r.error}</span>}</div>
      </div>
    );
  }
  const files = r.uploads ?? [];
  return (
    <div className="frame upl" data-id={item.id}>
      <div className="fh">
        <span className="tool mono">ask_upload</span>
        <span className="n" title={d.prompt}>{d.prompt || 'Files'}</span>
        <span className="end">{files.length} file{files.length === 1 ? '' : 's'} sent</span>
      </div>
      <ul className="upl-list">
        {files.map((f) => (
          <li key={f.path} title={f.path}>
            {f.src && <ToolImage src={f.src} alt={f.name} />}
            <span className="upl-n">{f.name}</span>
            <small>{sizeText(f.bytes)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ask_upload: a drop zone and a file picker; the files go to the server in one message and the agent gets their paths.
export function UploadAsk({ item }: { item: RichItem }) {
  const d = item.detail as Detail;
  const sessionId = useStore((s) => s.current);
  const [files, setFiles] = useState<Picked[]>(() => picked.get(item.id) ?? []);
  const [note, setNote] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(() => sent.get(item.id) ?? null);
  const input = useRef<HTMLInputElement>(null);
  const release = useEffectEvent((why: string) => {
    sent.delete(item.id);
    remember(item.id, files);
    setWaiting(null);
    setNote(why);
  });
  // A lost frame, a closed socket or a refused answer would otherwise leave "Sending…" up for good.
  useEffect(() => {
    if (!waiting || item.result) return;
    if (!useStore.getState().connected) return release('Connection lost. Try again.');
    const t = setTimeout(() => release('No answer from the server. Try again.'), SENT_WAIT_MS);
    const offSocket = useStore.subscribe((s, old) => old.connected && !s.connected && release('Connection lost. Try again.'));
    const offNotice = onNotice((m) => m.startsWith('Files not sent:') && release(m));
    return () => {
      clearTimeout(t);
      offSocket();
      offNotice();
    };
  }, [waiting, item.result]);
  if (item.result) return <UploadDone item={item} d={d} />;

  const update = (next: Picked[]) => {
    setFiles(next);
    remember(item.id, next);
  };
  const add = async (list: Iterable<File>) => {
    setNote(null);
    const all = [...list];
    const off = all.filter((f) => !acceptsFile(d.accept, f.name, f.type));
    setBusy(true);
    const { ok, skipped } = await readAll(all.filter((f) => !off.includes(f))).finally(() => setBusy(false));
    // The module copy is the latest list, even if another add finished while this one read.
    const now = picked.get(item.id) ?? [];
    update([...now, ...ok].slice(0, ASK_UPLOAD_MAX));
    const why = [
      ...(off.length ? [`Not accepted: ${names(off)} (this asks for ${d.accept.join(', ')})`] : []),
      ...(skipped.length ? [`Can't use ${skipped.join(', ')}: only images, PDFs and text files`] : []),
      ...(now.length + ok.length > ASK_UPLOAD_MAX ? [`${ASK_UPLOAD_MAX} files max, ${now.length + ok.length - ASK_UPLOAD_MAX} not added`] : []),
    ];
    if (why.length) setNote(why.join('. '));
  };
  const answer = (out: Upload[]) => {
    if (item.partial || !sessionId || waiting) return;
    if (out.reduce((n, u) => n + u.data.length, 0) > SEND_MAX) return setNote('These files are too large to send together. Remove some and try again.');
    const bad = out.map(uploadProblem).find(Boolean);
    if (bad) return setNote(`${bad}. Remove it and try again.`);
    if (!send({ type: 'upload-answer', sessionId, id: item.id, ...(out.length ? { files: out } : {}) })) return setNote('Not connected. Try again in a moment.');
    const line = out.length ? `Sending ${out.length} file${out.length > 1 ? 's' : ''}…` : 'Cancelling…';
    remember(item.id, []);
    sent.set(item.id, line);
    if (sent.size > PICKED_MAX) sent.delete(sent.keys().next().value!);
    setWaiting(line);
  };

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');
  const onOver = (e: DragEvent) => {
    if (!hasFiles(e) || waiting) return;
    e.preventDefault();
    setOver(true);
  };
  const onLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
  };
  // Marked as taken (preventDefault), so the composer's page-wide drop leaves these files alone; a sent card leaves them to it.
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e) || waiting) return;
    e.preventDefault();
    setOver(false);
    void add(e.dataTransfer.files);
  };

  return (
    <div className="frame choice aq upl" data-id={item.id}>
      <div className="fh"><span className="n">{d.prompt || 'Files requested'}</span></div>
      <div className={`upl-drop${over ? ' over' : ''}`} onDragEnter={onOver} onDragOver={onOver} onDragLeave={onLeave} onDrop={onDrop}>
        <span>Drop files here, or</span>
        <button type="button" className="opt upl-pick" disabled={waiting !== null || busy || files.length >= ASK_UPLOAD_MAX} onClick={() => input.current?.click()}>Choose files</button>
        {d.accept.length > 0 && <small className="mono">{d.accept.join(', ')}</small>}
        <input
          ref={input} type="file" multiple hidden accept={d.accept.join(',') || undefined}
          onChange={(e) => {
            const list = [...(e.target.files ?? [])];
            e.target.value = '';
            void add(list);
          }}
        />
      </div>
      {files.length > 0 && (
        <div className="upl-tray">
          {files.map((f) => (
            <FileChip key={f.key} file={{ name: f.upload.name, kind: f.upload.kind }} onRemove={waiting ? undefined : () => update(files.filter((x) => x !== f))} />
          ))}
        </div>
      )}
      {note && <p className="upl-note">{note}</p>}
      <div className="cf">
        {waiting ? <Pending text={waiting} /> : <span className="rnd-count">{busy ? 'Reading…' : `${files.length} of ${ASK_UPLOAD_MAX} files`}</span>}
        <span className="rnd-acts">
          <button type="button" className="opt" disabled={item.partial || waiting !== null} onClick={() => answer([])}>Cancel</button>
          <button type="button" className="go2" disabled={item.partial || waiting !== null || busy || !files.length} onClick={() => answer(files.map((f) => f.upload))}>Send files</button>
        </span>
      </div>
    </div>
  );
}
