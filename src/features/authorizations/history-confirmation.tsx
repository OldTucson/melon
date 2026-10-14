"use client";

import * as Dialog from "@radix-ui/react-dialog";

import { formatFenForDisplay } from "./api";

export type AuthorizationHistoryConfirmation = {
  activeCount: number;
  recent: Array<{
    id: string;
    licenseeName: string;
    authorizedOn: string;
    priceFen: string;
    fieldNameSnapshot?: string | null;
  }>;
};

export function HistoryConfirmation({
  details,
  isPending,
  onCancel,
  onConfirm,
}: {
  details: AuthorizationHistoryConfirmation;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !isPending) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="confirm-dialog history-confirmation-dialog"
          aria-describedby="history-confirmation-description"
        >
          <div className="confirm-dialog-header">
            <div>
              <Dialog.Title>确认授权历史</Dialog.Title>
              <Dialog.Description id="history-confirmation-description">
                当前范围内已有 {details.activeCount} 条有效授权。继续保存可能改变后续可授权范围，请确认你已核对历史记录。
              </Dialog.Description>
            </div>
          </div>
          {details.recent.length > 0 ? (
            <ul className="history-confirmation-list">
              {details.recent.map((item) => (
                <li key={item.id}>
                  <span>{item.licenseeName}</span>
                  <span>
                    {item.fieldNameSnapshot ?? "全领域"} · {item.authorizedOn}
                  </span>
                  <strong>{formatFenForDisplay(item.priceFen)}</strong>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="confirm-dialog-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={isPending}
              onClick={onCancel}
            >
              返回核对
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={isPending}
              onClick={onConfirm}
            >
              仍然保存
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
