import pandas as pd
from datetime import datetime, timedelta

# Read the CSV data
df = pd.read_csv('ZIEL_STELLENPLAN_SIMPLE.csv', parse_dates=['GUELTIG_AB'])

# Create a date range from today for 1 year
start_date = datetime.now().date()
end_date = start_date + timedelta(days=365)
date_range = pd.date_range(start=start_date, end=end_date, freq='D')

# Dictionary to map weekday numbers to column names
weekday_map = {
    0: 'SONNTAG',
    1: 'MONTAG',
    2: 'DIENSTAG',
    3: 'MITTWOCH',
    4: 'DONNERSTAG',
    5: 'FREITAG',
    6: 'SAMSTAG'
}

# Initialize lists to store the transformed data
timestamps = []
cost_centers = []
values = []

# Process each outlet
for outlet_id in df['OUTLET_ID'].unique():
    outlet_data = df[df['OUTLET_ID'] == outlet_id].sort_values('GUELTIG_AB')
    
    # Process each date in the date range
    for date in date_range:
        # Find the most recent valid row for this date
        valid_rows = outlet_data[outlet_data['GUELTIG_AB'] <= date]
        if not valid_rows.empty:
            valid_row = valid_rows.iloc[-1]  # Get the most recent row
            
            # Get the weekday value from the appropriate column
            weekday_col = weekday_map[date.weekday()]
            value = valid_row[weekday_col]
            
            # Append to our lists
            timestamps.append(date.strftime('%Y-%m-%d'))
            cost_centers.append(outlet_id)
            values.append(value)

# Create the final dataframe
result_df = pd.DataFrame({
    'timestamp': timestamps,
    'costCenter': cost_centers,
    'metricType': 'Umsatz Stellenplan',
    'value': values
})

# Sort the results
result_df = result_df.sort_values(['costCenter', 'timestamp'])

# Save to CSV
result_df.to_csv('ziel_stellenplan_transformed.csv', index=False)

# Print some statistics
print(f"Total number of records: {len(result_df)}")
print("\nFirst few rows:")
print(result_df.head())
print("\nSample of dates for one cost center:")
print(result_df[result_df['costCenter'] == result_df['costCenter'].iloc[0]].head())