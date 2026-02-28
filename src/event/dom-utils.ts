const SENSITIVE_AUTOCOMPLETE =
	/cc-number|cc-cvc|cc-exp|new-password|current-password/;
const SENSITIVE_NAME = /ssn|social|tax.?id|credit.?card/i;

export function isSensitiveField(el: Element): boolean {
	if (el instanceof HTMLInputElement) {
		if (el.type === "password") return true;
		const ac = el.autocomplete || "";
		if (SENSITIVE_AUTOCOMPLETE.test(ac)) return true;
		if (SENSITIVE_NAME.test(el.name || "") || SENSITIVE_NAME.test(el.id || ""))
			return true;
	}
	return false;
}
