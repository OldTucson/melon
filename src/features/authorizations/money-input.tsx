import { forwardRef } from "react";

export const MoneyInput = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function MoneyInput(props, ref) {
  return (
    <div className="money-input">
      <span aria-hidden="true">¥</span>
      <input
        {...props}
        ref={ref}
        inputMode="decimal"
        autoComplete="off"
      />
    </div>
  );
});
