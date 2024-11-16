// deno-lint-ignore-file no-explicit-any
interface RetryOptions<T> {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  shouldRetry?: (error: any) => boolean;
  onRetry?: (error: any, attempt: number) => void;
  retryableErrors?: Array<new (...args: any[]) => Error>;
}

/**
 * Retries a function with exponential backoff
 * @param f - The function to retry
 * @param options - Optional configuration
 * @returns Promise with the function result
 * @throws Last error encountered if all retries fail
 */
export async function retry<T>(
  f: () => Promise<T>,
  options: RetryOptions<T> = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    shouldRetry = () => true,
    onRetry = () => {},
    retryableErrors = [],
  } = options;

  let attempts = 0;
  let lastError: Error;

  while (attempts < maxAttempts) {
    try {
      return await f();
    } catch (error) {
      attempts++;
      lastError = error as Error;

      // Check if error is retryable based on error types
      const isRetryableError = retryableErrors.length === 0 ||
        retryableErrors.some((errorType) => error instanceof errorType);

      // If we've used all attempts or shouldn't retry, throw the error
      if (
        attempts >= maxAttempts ||
        !shouldRetry(error) ||
        !isRetryableError
      ) {
        throw error;
      }

      // Notify about retry attempt
      onRetry(error, attempts);

      // Calculate delay with exponential backoff
      const delay = Math.min(
        initialDelay * Math.pow(2, attempts - 1),
        maxDelay,
      );

      // Add some jitter to prevent thundering herd
      const jitter = Math.random() * 100;

      // Wait before next attempt
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }

  throw lastError!;
}
