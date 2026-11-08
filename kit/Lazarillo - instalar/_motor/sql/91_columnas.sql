SELECT table_name, ordinal_position, column_name, data_type
FROM information_schema.columns
WHERE table_schema = DATABASE()
ORDER BY table_name, ordinal_position;
