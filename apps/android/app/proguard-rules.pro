# Remo has no reflection of its own: records are read and written with org.json
# and SQLite directly. The libraries (Compose, Play services, WorkManager) ship
# their own consumer rules.

# Keep readable stack traces in crash reports.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
