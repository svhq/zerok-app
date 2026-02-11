pragma circom 2.1.5;

/**
 * DiscriminatorToField Gadget
 *
 * Converts an 8-byte discriminator to a field element matching Light Protocol's
 * discriminator encoding: 32-byte array with marker byte at position 23.
 *
 * Layout:
 *   bytes[0..22] = 0x00 (23 zero bytes)
 *   bytes[23]    = 0x02 (marker byte)
 *   bytes[24..31] = discriminator[0..7] (8-byte discriminator)
 *
 * Field element (big-endian integer interpretation):
 *   field = 2*256^8 + disc[0]*256^7 + disc[1]*256^6 + ... + disc[7]*256^0
 *
 * Example: discriminator = [3,4,5,6,7,8,9,10]
 *   Tagged array: [0,0,...,0,2,3,4,5,6,7,8,9,10]
 *   Field value:  2*256^8 + 3*256^7 + 4*256^6 + 5*256^5 + 6*256^4 + 7*256^3 + 8*256^2 + 9*256 + 10
 */
template DiscriminatorToField() {
    signal input discriminator[8];  // 8-byte discriminator array
    signal output field;             // Field element representation

    // Pre-compute powers of 256
    var pow256[9];
    pow256[0] = 1;
    for (var i = 1; i < 9; i++) {
        pow256[i] = pow256[i-1] * 256;
    }

    // Compute field element: marker_byte * 256^8 + sum(disc[i] * 256^(7-i))
    signal terms[9];

    // Marker byte contribution (byte 23 -> position 8 from the end)
    terms[0] <== 2 * pow256[8];

    // Discriminator bytes contributions
    for (var i = 0; i < 8; i++) {
        terms[i + 1] <== discriminator[i] * pow256[7 - i];
    }

    // Sum all terms
    signal accumulator[9];
    accumulator[0] <== terms[0];
    for (var i = 1; i < 9; i++) {
        accumulator[i] <== accumulator[i-1] + terms[i];
    }

    field <== accumulator[8];
}
