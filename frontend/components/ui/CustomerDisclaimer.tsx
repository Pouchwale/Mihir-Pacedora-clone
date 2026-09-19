// Scrolling disclaimer shown to customers: the 3D preview is not an exact match of the printed pouch.
export const CUSTOMER_DISCLAIMER =
  "Disclaimer: The 3D visual shown above is for reference only. The actual printed product may not look exactly the same as this preview.";

export function CustomerDisclaimer({ className = "" }: { className?: string }) {
  return (
    <div role="note" aria-label={CUSTOMER_DISCLAIMER} className={`customer-disclaimer overflow-hidden whitespace-nowrap ${className}`}>
      <span aria-hidden="true" className="customer-disclaimer-track text-red-600 font-extrabold text-sm tracking-wide">
        ⚠️ {CUSTOMER_DISCLAIMER}
      </span>
    </div>
  );
}
