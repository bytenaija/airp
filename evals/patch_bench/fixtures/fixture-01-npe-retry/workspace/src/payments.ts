export function retryWithBackoff(response: any): { status: number; success: boolean } {
  // Vulnerable logic: null response dereference
  if (response.status === 200) {
    return { status: 200, success: true };
  }
  return { status: response.status || 500, success: false };
}
