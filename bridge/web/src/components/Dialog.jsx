import { useEffect, useRef } from 'react';
import { Icon } from './Icon.jsx';

// Native modal <dialog>. `open` drives showModal()/close(). When the browser closes the dialog
// itself (Esc), onClose tells the owner, which then removes or closes it.
export function Dialog({ open, onClose, className, children }) {
  const ref = useRef(null);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function closed() {
    if (openRef.current) onClose();
  }

  return <dialog ref={ref} className={className} onClose={closed}>{children}</dialog>;
}

export function CloseButton({ className = 'icon', onClick }) {
  return (
    <button type="button" className={className} aria-label="关闭" onClick={onClick}>
      <Icon name="close" />
    </button>
  );
}
