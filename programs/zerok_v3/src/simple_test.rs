#[cfg(test)]
mod simple_tests {
    use crate::{
        encode_u64_as_32_bytes, // change_endianness removed
        reconstruct_address_from_high_low, split_address_to_high_low,
    };
    use anchor_lang::prelude::Pubkey;

    // #[test] // Disabled: change_endianness removed
    #[allow(dead_code)]
    fn _disabled_test_change_endianness_simple() {
        let input = vec![1, 2, 3, 4, 5, 6, 7, 8];
        // let output = change_endianness(&input);
        let output = input.clone(); // Function removed
        
        // Should reverse the first 8 bytes
        assert_eq!(output[0], 8);
        assert_eq!(output[1], 7);
        assert_eq!(output[2], 6);
        assert_eq!(output[3], 5);
        assert_eq!(output[4], 4);
        assert_eq!(output[5], 3);
        assert_eq!(output[6], 2);
        assert_eq!(output[7], 1);
        
        // Double conversion should return original
        // let double = change_endianness(&output);
        let double = output.clone(); // Function removed
        assert_eq!(input, double);
    }

    #[test]
    fn test_encode_u64_simple() {
        let mut output = [0u8; 32];
        encode_u64_as_32_bytes(1000, &mut output);
        
        // Should be right-aligned big-endian
        assert_eq!(&output[0..24], &[0u8; 24]);
        assert_eq!(&output[24..32], &1000u64.to_be_bytes());
    }

    #[test]
    fn test_split_address_simple() {
        let address = Pubkey::new_from_array([
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
            17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32
        ]);
        
        let (high, low) = split_address_to_high_low(&address);
        
        // High should have padding then first 16 bytes
        assert_eq!(&high[0..16], &[0u8; 16]);
        assert_eq!(&high[16..32], &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
        
        // Low should have padding then last 16 bytes  
        assert_eq!(&low[0..16], &[0u8; 16]);
        assert_eq!(&low[16..32], &[17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
        
        // Should be able to reconstruct
        let reconstructed = reconstruct_address_from_high_low(&high, &low);
        assert_eq!(address, reconstructed);
    }
}