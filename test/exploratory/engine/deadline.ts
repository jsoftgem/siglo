/** Bound test waits without leaving the deadline timer behind after successful completion. */
export async function within<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(label)), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
