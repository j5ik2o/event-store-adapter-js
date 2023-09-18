#! /usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
from datetime import datetime, timezone

args = sys.argv

server_url = args[1]
repo_name = args[2]
previous_tag = args[3]
next_tag = args[4]

repo_url = f"{server_url}/{repo_name}"
compare_url = f"{repo_url}/compare/{previous_tag}...{next_tag}"

next_version = next_tag.replace("v", "")

utc_now = datetime.now(timezone.utc)
today = utc_now.strftime("%Y-%m-%d")

header=f"""
### [{next_version}]({compare_url}) ({today})

"""

print(header)

