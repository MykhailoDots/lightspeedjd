# Small Foot TagiNet Calculation Implementation State

## Project Goal
Implement complex age-based weight calculation for Small Foot organization in the TagiNet importer, replacing the current static modifier system.

## Requirements
1. Age-based weight calculation:
   - Children under 18 months: weight 1.5
   - Children 18-36 months: weight 1.0
   - Children over 36 months: weight 0.8
   - Children turning 5 after June 30th of the year: weight 0.5

2. Add configuration for unweighted cost centers/mandanten

3. Create unit tests for the weight calculation function

## Current Progress

### ✅ Completed Tasks
1. **Analyzed TagiNet importer** (src/sources/taginet.ts)
   - Current implementation at lines 83-92
   - Uses static weight thresholds from config
   - Calculates age in months using dayjs

2. **Reviewed Small Foot configuration** (src/configs/small-foot.ts)
   - Current config uses ageWeightThresholdMonths: 18
   - youngChildWeight: 1.5, olderChildWeight: 1

### ✅ Completed Tasks (continued)
4. **Implemented age-based weight calculation logic**
   - ✅ Added `calculateChildWeight` function with complex age rules
   - ✅ Added `unweightedCostCenters` field to TagiNetSourceConfig
   - ✅ Updated import logic to use new weight calculation
   - ✅ Moved weight calculation inside day loop for accurate booking date weights

5. **Added configuration for unweighted cost centers**
   - ✅ Added optional `unweightedCostCenters` array to TagiNetSourceConfig
   - ✅ Implemented logic to check if mandant should use unweighted values

6. **Created unit tests for weight calculation**
   - ✅ Created comprehensive test suite in `src/sources/taginet.test.ts`
   - ✅ Tests all age ranges and edge cases
   - ✅ Special tests for 5-year-old rule with June 30th cutoff

7. **Updated Small Foot config with new settings**
   - ✅ Removed deprecated weight fields (ageWeightThresholdMonths, youngChildWeight, olderChildWeight)
   - ✅ Added `unweightedCostCenters: []` for future use

## Implementation Plan

### 1. Create Weight Calculation Function
**Location**: src/sources/taginet.ts

Create a new function `calculateChildWeight` that:
- Takes birth date and booking date as parameters
- Calculates age in months at booking date
- Returns weight based on age rules
- Special case for 5-year-olds after June 30th

```typescript
function calculateChildWeight(birthDate: string, bookingDate: string): number {
  const birth = dayjs(birthDate);
  const booking = dayjs(bookingDate);
  const ageInMonths = booking.diff(birth, "month");
  
  // Check if child turns 5 after June 30th
  const yearOfBooking = booking.year();
  const fifthBirthday = birth.add(5, "year");
  const june30 = dayjs(`${yearOfBooking}-06-30`);
  
  if (fifthBirthday.isAfter(june30) && fifthBirthday.year() === yearOfBooking) {
    return 0.5;
  }
  
  // Age-based weights
  if (ageInMonths < 18) return 1.5;
  if (ageInMonths <= 36) return 1.0;
  return 0.8;
}
```

### 2. Update TagiNetSourceConfig Interface
**Location**: src/sources/taginet.ts

Add new optional field:
```typescript
interface TagiNetSourceConfig extends BaseSourceConfig {
  // ... existing fields ...
  unweightedCostCenters?: string[]; // Cost centers that should not apply weights
}
```

### 3. Modify Import Logic
**Location**: src/sources/taginet.ts (lines 83-92)

Replace current weight calculation with:
```typescript
// Check if this cost center should use unweighted values
const isUnweighted = source.unweightedCostCenters?.includes(entry.gueltig_fuer_mandant);

// Calculate weight based on age or use 1 for unweighted centers
const weight = isUnweighted ? 1 : calculateChildWeight(entry.k_geburtsdatum, entry.b_von_datum);
```

### 4. Remove Deprecated Config Fields
From TagiNetSourceConfig:
- Remove `ageWeightThresholdMonths`
- Remove `youngChildWeight`
- Remove `olderChildWeight`

### 5. Create Unit Tests
**Location**: src/sources/taginet.test.ts (new file)

Test cases:
- Child under 18 months → weight 1.5
- Child exactly 18 months → weight 1.0
- Child 24 months → weight 1.0
- Child exactly 36 months → weight 1.0
- Child 37 months → weight 0.8
- Child turning 5 after June 30th → weight 0.5
- Child turning 5 before June 30th → age-based weight
- Unweighted cost center → weight 1.0

### 6. Update Small Foot Configuration
**Location**: src/configs/small-foot.ts

Remove old weight fields and add unweighted cost centers if needed:
```typescript
{
  name: "taginet",
  type: "taginet",
  // Remove: ageWeightThresholdMonths, youngChildWeight, olderChildWeight
  unweightedCostCenters: [], // Add specific mandanten if needed
  // ... rest of config
}
```

## Implementation Summary

### Changes Made

1. **src/config.ts**
   - Added `unweightedCostCenters?: string[]` to TagiNetSourceConfig interface

2. **src/sources/taginet.ts**
   - Added `calculateChildWeight` function implementing the complex age-based rules:
     - Under 18 months: 1.5
     - 18-36 months: 1.0
     - Over 36 months: 0.8
     - Turning 5 after June 30th: 0.5
   - Updated import logic to:
     - Check if mandant is in unweightedCostCenters list
     - Calculate weight per booking date (not current date)
     - Use weight 1.0 for unweighted centers

3. **src/sources/taginet.test.ts** (new file)
   - Comprehensive unit tests for all weight scenarios
   - Edge case testing for June 30th cutoff
   - Leap year handling tests

4. **src/configs/small-foot.ts**
   - Removed old weight configuration fields
   - Added empty `unweightedCostCenters` array for future configuration

## Commands Used
- None (following requirement not to run the app)

## Post-Implementation Fix
- Completely removed old weight fields from TagiNetSourceConfig (ageWeightThresholdMonths, youngChildWeight, olderChildWeight)
- Removed unnecessary type assertion in small-foot.ts
- Clean interface with only the new unweightedCostCenters configuration

## Next Steps When Allowed to Run
1. Run unit tests: `bun test src/sources/taginet.test.ts`
2. Run linter and type checking
3. Test with actual Small Foot data
4. Monitor for any edge cases in production

## Configuration Notes
To add mandanten that should not use weights, update the Small Foot config:
```typescript
unweightedCostCenters: ["MandantName1", "MandantName2"]
```