// Generated from @google-cloud/spanner 9.1.0 build/protos/status.json.
// Copyright Google LLC. Apache-2.0. See docs/third-party/spanner-retry-info.md.
export const retryInfoSchema = {
  nested: {
    google: {
      nested: {
        rpc: {
          nested: {
            RetryInfo: {
              fields: {
                retryDelay: {
                  type: "google.protobuf.Duration",
                  id: 1,
                },
              },
            },
          },
        },
        protobuf: {
          nested: {
            Duration: {
              fields: {
                seconds: {
                  type: "int64",
                  id: 1,
                },
                nanos: {
                  type: "int32",
                  id: 2,
                },
              },
            },
          },
        },
      },
    },
  },
};
