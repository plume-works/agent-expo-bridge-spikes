module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    spikePlain: process.env.SPIKE_PLAIN ?? null,
    spikeSecretA: process.env.SPIKE_SECRET_A ?? null,
    spikeSecretB: process.env.SPIKE_SECRET_B ?? null,
  },
});
