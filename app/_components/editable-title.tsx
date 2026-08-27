'use client';

import { useEffect, useRef, useState } from 'react';
import { PencilIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Click-to-edit text. Enter/blur saves (trimmed, non-empty), Escape cancels.
 * Save is optimistic — the parent owns the value and reverts on failure.
 */
export function EditableTitle({
  value,
  placeholder,
  onSave,
  className,
  editing: editingProp,
  onEditingChange,
}: {
  readonly value: string | null;
  readonly placeholder: string;
  readonly onSave: (title: string) => void | Promise<void>;
  readonly className?: string;
  readonly editing?: boolean;
  readonly onEditingChange?: (editing: boolean) => void;
}) {
  const [editingState, setEditingState] = useState(false);
  const editing = editingProp ?? editingState;
  const setEditing = (next: boolean) => {
    setEditingState(next);
    onEditingChange?.(next);
  };
  const [draft, setDraft] = useState(value ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value ?? '');
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, value]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== (value ?? '')) void onSave(next);
  };

  if (editing) {
    return (
      <input
        className={cn('w-full min-w-0 rounded border bg-background px-1.5 py-0.5 text-sm outline-none ring-ring focus:ring-1', className)}
        maxLength={80}
        onBlur={commit}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
        ref={inputRef}
        value={draft}
      />
    );
  }

  return (
    <span className={cn('group/title inline-flex min-w-0 items-center gap-1', className)}>
      <span className="truncate">{value?.trim() || placeholder}</span>
      <button
        aria-label="Rename"
        className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground group-hover/title:inline-flex"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        title="Rename"
        type="button"
      >
        <PencilIcon className="size-3" />
      </button>
    </span>
  );
}
