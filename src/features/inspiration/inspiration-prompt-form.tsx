"use client";

import { useId, useState } from "react";
import { Sparkles } from "lucide-react";
import {
  inspirationCreateMutationSchema,
  type InspirationCreateMutation,
} from "./contracts";
import styles from "./inspiration.module.css";

export function InspirationPromptForm({
  pending,
  blocked,
  onSubmit,
}: {
  pending: boolean;
  blocked: boolean;
  onSubmit: (input: InspirationCreateMutation) => void;
}) {
  const id = useId();
  const [prompt, setPrompt] = useState("");
  const valid =
    inspirationCreateMutationSchema.shape.prompt.safeParse(prompt).success;
  return (
    <form
      className={styles.promptForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || blocked || !valid) return;
        onSubmit(
          inspirationCreateMutationSchema.parse({
            prompt,
            operationId: crypto.randomUUID(),
          }),
        );
      }}
    >
      <label htmlFor={id}>研究需求</label>
      <textarea
        id={id}
        value={prompt}
        maxLength={1000}
        rows={3}
        placeholder="分析近 30 天都市轻通勤女装"
        onChange={(event) => setPrompt(event.target.value)}
      />
      <div className={styles.formActions}>
        <button
          className={styles.primaryButton}
          type="submit"
          disabled={!valid || pending || blocked}
        >
          <Sparkles aria-hidden="true" />
          {pending ? "分析中…" : "开始分析"}
        </button>
      </div>
    </form>
  );
}
