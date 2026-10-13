// Shared by the unit and e2e suites: any fetch a test has not mocked fails
// instead of reaching the network, so tests can never send a real message.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Unmocked fetch call in a test'))),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
