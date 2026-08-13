#!/bin/bash
# Pull real block headers off a live PCoin node as validator test vectors.
#
# Each line is:  <height> <80-byte header hex> <bits> <blockhash>
#
# The header hex is what RandomX actually hashes -- the same 80 bytes, byte for
# byte, that the node hashed when it accepted the block. That is the point of
# using real blocks rather than synthetic ones: a vector the chain has already
# accepted cannot be wrong about the format, the byte order, or the target.
#
#   ./make-vectors.sh 100 > vectors.txt        # last 100 blocks
#   ./make-vectors.sh 100 3000 > vectors.txt   # 100 ending at height 3000
#
# Run it where bitcoin-cli can reach a node. On a seed that means through
# docker: CLI="sudo docker exec pcoin-seed bitcoin-cli" ./make-vectors.sh 100
set -u
COUNT=${1:-100}
CLI=${CLI:-bitcoin-cli}

tip=$($CLI getblockcount 2>/dev/null) || { echo "no node" >&2; exit 1; }
END=${2:-$tip}
START=$(( END - COUNT + 1 ))
# Below 2800 the difficulty algorithm is the legacy one. The PoW hash is the
# same either way, so those blocks are still valid vectors -- but keep the
# default window in the LWMA era so a failure means one thing, not two.
[ "$START" -lt 1 ] && START=1

for h in $(seq "$START" "$END"); do
  hash=$($CLI getblockhash "$h" 2>/dev/null) || continue
  hdr=$($CLI getblockheader "$hash" false 2>/dev/null) || continue
  bits=$($CLI getblockheader "$hash" 2>/dev/null | sed -n 's/.*"bits": *"\([0-9a-f]*\)".*/\1/p')
  [ ${#hdr} -eq 160 ] || { echo "height $h: header is ${#hdr} hex chars, expected 160" >&2; continue; }
  echo "$h $hdr $bits $hash"
done
