// Type a string into a target input or contentEditable element one character
// at a time, dispatching events that React's reconciler observes so the
// product's controlled input state stays in sync.
//
// React intercepts native value setters on <input>/<textarea> via a
// prototype-level descriptor, then dispatches 'input' events to its own
// synthetic event system. To make a fake change visible to React, we
// have to invoke the native setter via the prototype descriptor and then
// dispatch a real 'input' event. Setting `el.value = ...` directly is
// silently ignored by React's onChange.

// Version marker so we can verify the dev bundle actually reloaded after
// editing this file. Check `window.__OPENSWARM_TYPEINTO__` in DevTools
// — if it's missing or shows an older tag, Electron's renderer is
// running a cached bundle and needs a Cmd+R hard-reload.
if (typeof window !== 'undefined') {
  (window as any).__OPENSWARM_TYPEINTO__ = 'v2-dom-direct-2026-05-12';
}

const INPUT_PROTO_VALUE_DESC =
  typeof window !== 'undefined'
    ? Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )
    : undefined;

const TEXTAREA_PROTO_VALUE_DESC =
  typeof window !== 'undefined'
    ? Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )
    : undefined;

function nativeSetValue(el: HTMLElement, value: string): void {
  if (el instanceof HTMLInputElement && INPUT_PROTO_VALUE_DESC?.set) {
    INPUT_PROTO_VALUE_DESC.set.call(el, value);
  } else if (
    el instanceof HTMLTextAreaElement &&
    TEXTAREA_PROTO_VALUE_DESC?.set
  ) {
    TEXTAREA_PROTO_VALUE_DESC.set.call(el, value);
  } else {
    (el as HTMLInputElement).value = value;
  }
}

function dispatchInput(el: HTMLElement): void {
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// contentEditable fields (the agent chat input is one) need a different
// path than <input>/<textarea>. Setting textContent nukes rich-content
// children (skill pills, etc), so we append a Text node at the end and
// dispatch a real InputEvent that React's reconciler treats as a
// keystroke. We used to call document.execCommand('insertText') here
// instead — that's the "idiomatic" way to programmatically type into a
// contentEditable — but in Electron with a webview loaded in the
// preview pane (App Builder step 8 / step 5 / step 6 all hit this),
// the webview steals document focus during its load. execCommand
// requires the host document to be focused AND the active element to
// be editable; without focus it silently no-ops while still returning
// true, so the wizard's `typeInto` "succeeded" but no characters ever
// landed, hasContent stayed false on the chat input, the send button
// never rendered, and step 8's `move_to chatSendButton` then burned
// its 15 s waitForSelector and threw into the recovery popup. The
// AC's "cursor" is purely visual — it never fires real focus events
// — so there's no way to get document focus back without the user
// clicking. DOM-level insertion + dispatched InputEvent works
// regardless of focus state.
function insertContentEditableText(el: HTMLElement, ch: string): void {
  el.focus();
  // Append at the very end of the editable. Walk to the deepest
  // last-text-node so we don't insert into the middle of a skill pill
  // wrapper (those are inline-block element children with their own
  // text). If the last child is an element (e.g., a <span> skill
  // pill), we append a sibling text node after it.
  const range = document.createRange();
  const last = el.lastChild;
  if (last && last.nodeType === Node.TEXT_NODE) {
    range.setStart(last, (last.nodeValue ?? '').length);
    range.collapse(true);
    (last as Text).appendData(ch);
    range.setStart(last, (last.nodeValue ?? '').length);
    range.collapse(true);
  } else {
    const textNode = document.createTextNode(ch);
    el.appendChild(textNode);
    range.setStart(textNode, ch.length);
    range.collapse(true);
  }
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
  // React's controlled-input bridge listens for `input` events. The
  // `inputType: insertText` + `data: ch` mirrors what a real keystroke
  // produces, so handleInput → updateHasContent fires and hasContent
  // flips true → the send button finally renders.
  el.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      data: ch,
      inputType: 'insertText',
    }),
  );
}

export interface TypeIntoOptions {
  speedMs?: number;
  // Optional callback fired after each character — lets the cursor
  // re-align to the input's right edge as text grows.
  onTick?: () => void;
}

function readEffectiveText(el: HTMLElement): string {
  if (el.isContentEditable) return (el.textContent ?? '').trim();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return (el.value ?? '').trim();
  }
  return (el.textContent ?? '').trim();
}

export async function typeInto(
  el: HTMLElement,
  text: string,
  opts: TypeIntoOptions = {},
): Promise<void> {
  // Default char-cadence — faster than the original 40ms (which felt
  // like watching molasses for long URLs). 18ms is still slow enough to
  // read live but doesn't make typing the main bottleneck of the step.
  const speed = opts.speedMs ?? 18;
  el.focus();

  // Per-character cadence is constant (no jitter — variable timing reads
  // as glitchy, not natural). The one exception: insert a natural-reading
  // pause after a comma / sentence-terminator / colon / semicolon so the
  // streamed text breathes the way a human would. Anything else types at
  // the constant `speed` value, beat by beat.
  const punctPause = (ch: string): number => {
    if (ch === ',') return 220;
    if (ch === '.' || ch === '!' || ch === '?') return 320;
    if (ch === ':' || ch === ';') return 180;
    return 0;
  };

  // Branch on element kind. contentEditable (the agent ChatInput uses
  // a contentEditable div for skill-pill support) requires execCommand;
  // <input>/<textarea> require the React-prototype-setter dance.
  if (el.isContentEditable) {
    for (const ch of text) {
      insertContentEditableText(el, ch);
      opts.onTick?.();
      await new Promise((r) => window.setTimeout(r, speed + punctPause(ch)));
    }
  } else {
    let acc = '';
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      acc = el.value ?? '';
    }
    for (const ch of text) {
      acc += ch;
      nativeSetValue(el, acc);
      dispatchInput(el);
      opts.onTick?.();
      await new Promise((r) => window.setTimeout(r, speed + punctPause(ch)));
    }
  }

  // Post-type verification. Under heavy main-thread load (many agents
  // streaming concurrently), execCommand('insertText') can silently
  // no-op while React's reconciler is starved — AC "types" but the
  // characters never land in the controlled input. Without this check,
  // step 8 (App Builder) would "complete" with an empty draft and the
  // user would see no app get built.
  //
  // After typing, give React up to 500ms to commit, then re-read the
  // effective text. If it's missing most of what we typed, fall back
  // to a single-shot insert that's much more reliable under load.
  const target = text.trim();
  if (!target) return;
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => window.setTimeout(r, 100));
    const got = readEffectiveText(el);
    if (got.length >= Math.floor(target.length * 0.8)) return;
  }

  // Fallback: nuke contents and insert the full string in one shot.
  // Loses the typing animation but preserves the user-visible outcome.
  try {
    if (el.isContentEditable) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      try {
        document.execCommand('delete', false);
      } catch {
        /* fall through */
      }
      try {
        const ok = document.execCommand('insertText', false, text);
        if (!ok) {
          el.textContent = text;
          el.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              data: text,
              inputType: 'insertText',
            }),
          );
        }
      } catch {
        el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement
    ) {
      nativeSetValue(el, text);
      dispatchInput(el);
    }
  } catch {
    /* best-effort — runtime's wait_user will time out and recover */
  }
}
