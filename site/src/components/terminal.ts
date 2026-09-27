export type Line =
	| { kind: "cmd"; text: string }
	| {
			kind: "out";
			text: string;
			tone?: "ok" | "err" | "dim" | "add" | "del" | "hunk" | "plain";
	  };
