/**
 * Pure TypeScript MLP forward pass for the trained PPO policy network.
 *
 * Architecture (from stable-baselines3 MlpPolicy with MultiDiscrete([5,32,32,32,32,6]*4)):
 *   Input (5813) -> Linear(5813, 256) -> ReLU -> Linear(256, 256) -> ReLU -> Linear(256, 556)
 *
 * The 556 output logits split into 4x action heads: [5, 32, 32, 32, 32, 6] repeated 4 times.
 * Greedy decoding: argmax within each head.
 */

export interface ModelWeights {
  layers: Array<{
    weight: number[];  // flattened [outFeatures, inFeatures]
    bias: number[];    // [outFeatures]
    shape: number[];   // [outFeatures, inFeatures]
  }>;
}

// Action head sizes for MultiDiscrete([5, 32, 32, 32, 32, 6] * 4)
const ACTION_HEADS = [
  5, 32, 32, 32, 32, 6,  // action 0
  5, 32, 32, 32, 32, 6,  // action 1
  5, 32, 32, 32, 32, 6,  // action 2
  5, 32, 32, 32, 32, 6,  // action 3
];

export class RLInference {
  private layers: Array<{ weight: Float32Array; bias: Float32Array; outSize: number; inSize: number }> = [];
  private ready = false;

  loadWeights(data: ModelWeights): void {
    this.layers = data.layers.map((l) => ({
      weight: new Float32Array(l.weight),
      bias: new Float32Array(l.bias),
      outSize: l.shape[0],
      inSize: l.shape[1],
    }));
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Forward pass through the policy network.
   * Returns 24 values: 4 sub-actions of [actionType, srcGridX, srcGridZ, tgtGridX, tgtGridZ, param].
   */
  predict(input: Float32Array): number[] {
    if (!this.ready) return [0,0,0,0,0,0, 0,0,0,0,0,0, 0,0,0,0,0,0, 0,0,0,0,0,0]; // 4x NoOp

    // Layer 0: Linear + ReLU
    let h = this.linearRelu(input, this.layers[0]);
    // Layer 1: Linear + ReLU
    h = this.linearRelu(h, this.layers[1]);
    // Layer 2: Linear (action logits, no activation)
    const logits = this.linear(h, this.layers[2]);

    // Decode: argmax within each action head
    return this.decodeAction(logits);
  }

  private linear(
    input: Float32Array,
    layer: { weight: Float32Array; bias: Float32Array; outSize: number; inSize: number },
  ): Float32Array {
    const { weight, bias, outSize, inSize } = layer;
    const output = new Float32Array(outSize);
    for (let o = 0; o < outSize; o++) {
      let sum = bias[o];
      const rowOffset = o * inSize;
      for (let i = 0; i < inSize; i++) {
        sum += weight[rowOffset + i] * input[i];
      }
      output[o] = sum;
    }
    return output;
  }

  private linearRelu(
    input: Float32Array,
    layer: { weight: Float32Array; bias: Float32Array; outSize: number; inSize: number },
  ): Float32Array {
    const output = this.linear(input, layer);
    for (let i = 0; i < output.length; i++) {
      if (output[i] < 0) output[i] = 0;
    }
    return output;
  }

  private decodeAction(logits: Float32Array): number[] {
    const actions: number[] = [];
    let offset = 0;
    for (const headSize of ACTION_HEADS) {
      let bestIdx = 0;
      let bestVal = logits[offset];
      for (let i = 1; i < headSize; i++) {
        if (logits[offset + i] > bestVal) {
          bestVal = logits[offset + i];
          bestIdx = i;
        }
      }
      actions.push(bestIdx);
      offset += headSize;
    }
    return actions;
  }
}
