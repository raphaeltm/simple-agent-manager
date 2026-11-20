/** Tracks fetch readers so deletion can close streams before dropping their backing packs. */
export class HostedGitUploads {
  private slots = new Set<{ done: Promise<void>; cancel?: () => Promise<void> }>();
  start() {
    let finish = () => {};
    const slot: { done: Promise<void>; cancel?: () => Promise<void> } = {
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    this.slots.add(slot);
    const release = () => {
      this.slots.delete(slot);
      finish();
    };
    return {
      release,
      response: (response: Response): Response => {
        if (!response.body || !this.slots.has(slot)) return response;
        const reader = response.body.getReader();
        slot.cancel = async () => {
          await reader.cancel().catch(() => undefined);
          release();
        };
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const { done, value } = await reader.read();
                if (done) {
                  release();
                  controller.close();
                } else controller.enqueue(value);
              } catch (error) {
                release();
                controller.error(error);
              }
            },
            cancel: slot.cancel,
          }),
          { status: response.status, headers: response.headers }
        );
      },
    };
  }
  async close(): Promise<void> {
    const slots = [...this.slots];
    await Promise.all(slots.map((slot) => slot.cancel?.()));
    // Request bodies have a work deadline; their handlers release after seeing the delete fence.
    await Promise.all(slots.map((slot) => slot.done));
  }
}
