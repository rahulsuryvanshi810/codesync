import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { yCollab } from 'y-codemirror.next';

const LANG_EXTENSIONS = { javascript: () => javascript(), python: () => python() };

/**
 * CodeMirror 6 bound to a shared Y.Text. y-codemirror translates every local
 * keystroke into a CRDT operation and every remote operation into an editor change,
 * and draws other users' cursors and selections from awareness state.
 */
export default function Editor({ ytext, awareness, language, onRun }) {
  const host = useRef(null);
  const view = useRef(null);
  const langCompartment = useRef(new Compartment());
  const runRef = useRef(onRun);
  runRef.current = onRun;

  useEffect(() => {
    // Undo only reverts *your* changes, never a collaborator's.
    const undoManager = new Y.UndoManager(ytext);
    view.current = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => { runRef.current?.(); return true; } }])),
          basicSetup,
          oneDark,
          langCompartment.current.of(LANG_EXTENSIONS[language]?.() ?? []),
          EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'var(--mono)' } }),
          yCollab(ytext, awareness, { undoManager }),
        ],
      }),
    });
    return () => {
      view.current.destroy();
      undoManager.destroy();
    };
    // The editor is created once per Y.Text; language changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytext, awareness]);

  useEffect(() => {
    view.current?.dispatch({
      effects: langCompartment.current.reconfigure(LANG_EXTENSIONS[language]?.() ?? []),
    });
  }, [language]);

  return <div className="editor" ref={host} />;
}
